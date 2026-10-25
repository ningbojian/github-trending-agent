import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchQuery } from '../src/agent/parse-query';
import { searchCaches } from '../src/db/schema';

// ---------------------------------------------------------------------------
// db mock：searchTrending 只经 db() 访问数据库，测试绝不连接真实库。
// ---------------------------------------------------------------------------
const dbMock = vi.hoisted(() => ({
  executeQueries: [] as unknown[],
  executeRows: [] as Record<string, unknown>[],
  events: [] as string[],
  deleteCalls: [] as { table: unknown; condition: unknown }[],
  insertCalls: [] as { table: unknown; values: Record<string, unknown> }[],
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async (query: unknown) => {
      dbMock.executeQueries.push(query);
      return { rows: dbMock.executeRows };
    },
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        dbMock.events.push('delete');
        dbMock.deleteCalls.push({ table, condition });
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        dbMock.events.push('insert');
        dbMock.insertCalls.push({ table, values });
      },
    }),
  }),
}));

import { buildSearchSql, searchTrending } from '../src/agent/search';

/** 默认查询（模拟 LLM 已解析的结果），各用例按维度覆盖。 */
function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    intent: 'search',
    languages: [],
    keywords: [],
    period: 'week',
    minStars: null,
    sortBy: 'stars_delta',
    topN: 10,
    ...overrides,
  };
}

/** 把 drizzle SQL 对象编译为文本 + 参数，便于断言。 */
function compileQuery(wrapper: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(wrapper as SQL);
}

/** 取 from/join 之后的 where 片段（无 where 时为空串）。 */
function whereFragment(sqlText: string): string {
  const idx = sqlText.indexOf(' where ');
  return idx === -1 ? '' : sqlText.slice(idx);
}

// ---------------------------------------------------------------------------
// buildSearchSql：纯函数，单测各过滤维度组合。
// ---------------------------------------------------------------------------
describe('buildSearchSql（SQL/参数组装，不触库）', () => {
  it('基础查询：join repos、period=week → 7 天窗口、stars_delta 排序、limit topN', () => {
    const { sql, params } = buildSearchSql(makeQuery());
    expect(sql).toContain('from "trending_entries"');
    expect(sql).toContain(
      'join "repos" on "repos"."full_name" = "trending_entries"."full_name"',
    );
    expect(whereFragment(sql)).toContain(
      '"trending_entries"."date" >= now() - make_interval(days => $1)',
    );
    expect(params[0]).toBe(7);
    expect(sql).toContain(
      'order by "trending_entries"."full_name", "trending_entries"."stars_delta" desc',
    );
    expect(sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(params.at(-1)).toBe(10);
  });

  it('去重：distinct on (full_name)，内层按 full_name+原排序取首行，外层恢复原排序', () => {
    const { sql, params } = buildSearchSql(makeQuery({ sortBy: 'stars_delta' }));
    expect(sql).toContain('distinct on ("trending_entries"."full_name")');
    expect(sql).toContain(
      'order by "trending_entries"."full_name", "trending_entries"."stars_delta" desc',
    );
    expect(sql).toContain('order by "starsDelta" desc');
    expect(sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(params.at(-1)).toBe(10);
  });

  it('select 输出列以 SearchResultItem 的 camelCase 别名返回', () => {
    const { sql } = buildSearchSql(makeQuery());
    for (const alias of [
      'fullName',
      'description',
      'language',
      'stars',
      'starsDelta',
      'isNew',
      'date',
      'htmlUrl',
      'rank',
    ]) {
      expect(sql).toContain(`as "${alias}"`);
    }
  });

  it('period → 回看天数映射：today 1、week 7、month 30（全部参数化）', () => {
    const cases = [
      ['today', 1],
      ['week', 7],
      ['month', 30],
    ] as const;
    for (const [period, days] of cases) {
      const { sql, params } = buildSearchSql(makeQuery({ period }));
      expect(whereFragment(sql)).toContain(
        '"trending_entries"."date" >= now() - make_interval(days => $1)',
      );
      expect(params[0]).toBe(days);
    }
  });

  it('period=all 时不带任何日期条件', () => {
    const { sql, params } = buildSearchSql(makeQuery({ period: 'all' }));
    expect(sql).not.toContain('make_interval');
    expect(whereFragment(sql)).toBe('');
    expect(params).toEqual([10]); // 仅 limit topN
  });

  it('languages 为空时不过滤仓库语言', () => {
    const { sql } = buildSearchSql(makeQuery({ languages: [] }));
    expect(whereFragment(sql)).not.toContain('"repos"."language"');
  });

  it('languages 多值 → lower(repos.language) IN（各语言独立参数，q.languages 已小写不重复 lower）', () => {
    const { sql, params } = buildSearchSql(
      makeQuery({ languages: ['python', 'rust'] }),
    );
    expect(whereFragment(sql)).toMatch(
      /lower\("repos"\."language"\) in \(\$\d+, \$\d+\)/,
    );
    expect(whereFragment(sql)).not.toContain('trending_entries"."language"');
    expect(params).toContain('python');
    expect(params).toContain('rust');
  });

  it('languages 含 c++/c# 时原样进参数（不在 SQL 文本中拼接）', () => {
    const { sql, params } = buildSearchSql(
      makeQuery({ languages: ['c++', 'c#'] }),
    );
    expect(whereFragment(sql)).toMatch(
      /lower\("repos"\."language"\) in \(\$\d+, \$\d+\)/,
    );
    expect(params).toContain('c++');
    expect(params).toContain('c#');
  });

  it('keywords 为空时无 ilike 条件', () => {
    const { sql } = buildSearchSql(makeQuery({ keywords: [] }));
    expect(sql).not.toContain('ilike');
  });

  it('keywords 对 full_name/description/topics::text 做 ILIKE（字段间 OR，关键词间 AND）', () => {
    const { sql, params } = buildSearchSql(
      makeQuery({ keywords: ['ai', 'agent'] }),
    );
    expect(whereFragment(sql)).toContain('"repos"."full_name" ilike');
    expect(whereFragment(sql)).toContain('"repos"."description" ilike');
    expect(whereFragment(sql)).toContain('"repos"."topics"::text ilike');
    // 2 个关键词 × 3 个字段，且每个模式都以参数传入
    expect(sql.match(/ilike/g)).toHaveLength(6);
    expect(whereFragment(sql)).toContain(') and (');
    expect(params.filter((p) => p === '%ai%')).toHaveLength(3);
    expect(params.filter((p) => p === '%agent%')).toHaveLength(3);
  });

  it('关键词中的 ILIKE 通配符被转义，防止 % 变成万能匹配', () => {
    const { params } = buildSearchSql(makeQuery({ keywords: ['100%_x'] }));
    expect(params).toContain('%100\\%\\_x%');
  });

  it('minStars 为 null 时不过滤 stars；设值时参数化 >=', () => {
    const none = buildSearchSql(makeQuery({ minStars: null }));
    expect(whereFragment(none.sql)).not.toContain('"repos"."stars"');

    const filtered = buildSearchSql(makeQuery({ minStars: 5000 }));
    expect(whereFragment(filtered.sql)).toMatch(/"repos"\."stars" >= \$\d+/);
    expect(filtered.params).toContain(5000);
  });

  it('sortBy → 排序子句：stars_delta / stars / new（内层 full_name 打头，外层按别名恢复原语义）', () => {
    const delta = buildSearchSql(makeQuery({ sortBy: 'stars_delta' })).sql;
    expect(delta).toContain(
      'order by "trending_entries"."full_name", "trending_entries"."stars_delta" desc',
    );
    expect(delta).toContain('order by "starsDelta" desc');

    const stars = buildSearchSql(makeQuery({ sortBy: 'stars' })).sql;
    expect(stars).toContain(
      'order by "trending_entries"."full_name", "repos"."stars" desc',
    );
    expect(stars).toContain('order by "stars" desc');

    const fresh = buildSearchSql(makeQuery({ sortBy: 'new' })).sql;
    expect(fresh).toContain(
      'order by "trending_entries"."full_name", "trending_entries"."is_new" desc, "trending_entries"."rank" asc',
    );
    expect(fresh).toContain('order by "isNew" desc, "rank" asc');
  });

  it('topN 以参数出现在 limit 中', () => {
    const { sql, params } = buildSearchSql(makeQuery({ topN: 5 }));
    expect(sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(params.at(-1)).toBe(5);
  });

  it('注入防御：用户输入只进 params，永不拼进 SQL 文本', () => {
    const evilLang = "python'; drop table repos; --";
    const { sql, params } = buildSearchSql(
      makeQuery({
        languages: [evilLang],
        keywords: ["' or 1=1 --"],
        minStars: 999999,
      }),
    );
    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('1=1');
    expect(params).toContain(evilLang);
    expect(params).toContain("%' or 1=1 --%");
  });
});

// ---------------------------------------------------------------------------
// searchTrending：mock db 层，验证执行路径、结果映射与缓存覆盖写入。
// ---------------------------------------------------------------------------
describe('searchTrending（db mock，无真实数据库）', () => {
  beforeEach(() => {
    dbMock.executeQueries.length = 0;
    dbMock.executeRows.length = 0;
    dbMock.events.length = 0;
    dbMock.deleteCalls.length = 0;
    dbMock.insertCalls.length = 0;
  });

  const row: Record<string, unknown> = {
    fullName: 'vercel/next.js',
    description: 'The React Framework',
    language: 'TypeScript',
    stars: 128000,
    starsDelta: 321,
    isNew: false,
    date: '2026-10-22',
    htmlUrl: 'https://github.com/vercel/next.js',
    rank: 1,
  };

  it('返回 SearchResultItem 形状：camelCase 全字段', async () => {
    dbMock.executeRows.push({ ...row });
    const items = await searchTrending(makeQuery(), 'alice');
    expect(items).toEqual([
      {
        fullName: 'vercel/next.js',
        description: 'The React Framework',
        language: 'TypeScript',
        stars: 128000,
        starsDelta: 321,
        isNew: false,
        date: '2026-10-22',
        htmlUrl: 'https://github.com/vercel/next.js',
        rank: 1,
      },
    ]);
  });

  it('description / language 为 NULL 时保持 null（不丢字段）', async () => {
    dbMock.executeRows.push({
      ...row,
      fullName: 'x/blank',
      description: null,
      language: null,
    });
    const items = await searchTrending(makeQuery(), 'alice');
    expect(items[0]).toMatchObject({
      fullName: 'x/blank',
      description: null,
      language: null,
    });
  });

  it('同一 full_name 出现在多个日期/语言行时只返回 1 条（按 full_name 去重）', async () => {
    dbMock.executeRows.push(
      { ...row, date: '2026-10-20', language: 'TypeScript', rank: 3 },
      { ...row, date: '2026-10-22', language: 'JavaScript', rank: 1 },
    );
    const items = await searchTrending(makeQuery(), 'alice');
    expect(items).toHaveLength(1);
    expect(items.filter((i) => i.fullName === 'vercel/next.js')).toHaveLength(1);
    // 去重后的结果同样写入缓存（不多不少，等于返回值）
    expect(dbMock.insertCalls[0]?.values['results']).toEqual(items);
  });

  it('不同 full_name 互不影响：2 个不同仓库返回 2 条', async () => {
    dbMock.executeRows.push({ ...row }, { ...row, fullName: 'other/repo' });
    const items = await searchTrending(makeQuery(), 'alice');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.fullName)).toEqual([
      'vercel/next.js',
      'other/repo',
    ]);
  });

  it('查询无结果时返回 []', async () => {
    expect(await searchTrending(makeQuery(), 'alice')).toEqual([]);
  });

  it('执行的 SQL 按 period 映射天数并用 topN 限制条数', async () => {
    await searchTrending(makeQuery({ period: 'today', topN: 3 }), 'alice');
    const executed = compileQuery(dbMock.executeQueries[0]);
    expect(executed.sql).toContain('make_interval(days => $1)');
    expect(executed.params).toContain(1);
    expect(executed.sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(executed.params.at(-1)).toBe(3);
  });

  it('period=month 映射 30 天；period=all 不带日期条件', async () => {
    await searchTrending(makeQuery({ period: 'month' }), 'alice');
    expect(compileQuery(dbMock.executeQueries[0]).params).toContain(30);

    await searchTrending(makeQuery({ period: 'all' }), 'alice');
    const allExecuted = compileQuery(dbMock.executeQueries[1]);
    expect(allExecuted.sql).not.toContain('make_interval');
    expect(whereFragment(allExecuted.sql)).toBe('');
  });

  it('结果按 wecom_userid 覆盖写入 search_caches：先 delete 再 insert', async () => {
    dbMock.executeRows.push({ ...row });
    const items = await searchTrending(makeQuery(), 'bob');

    expect(dbMock.events).toEqual(['delete', 'insert']);

    const del = dbMock.deleteCalls[0];
    expect(del?.table).toBe(searchCaches);
    const condition = compileQuery(del?.condition);
    expect(condition.sql).toContain('"search_caches"."wecom_userid" = $1');
    expect(condition.params).toEqual(['bob']);

    const ins = dbMock.insertCalls[0];
    expect(ins?.table).toBe(searchCaches);
    expect(ins?.values).toMatchObject({ wecomUserid: 'bob' });
    expect(ins?.values['results']).toEqual(items);
  });

  it('不同用户各写各的缓存行（互不串写）', async () => {
    await searchTrending(makeQuery(), 'u1');
    await searchTrending(makeQuery(), 'u2');
    expect(
      dbMock.deleteCalls.map((c) => compileQuery(c.condition).params[0]),
    ).toEqual(['u1', 'u2']);
    expect(dbMock.insertCalls.map((c) => c.values['wecomUserid'])).toEqual([
      'u1',
      'u2',
    ]);
  });
});
