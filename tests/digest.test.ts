import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import handler, {
  type CronRequest,
  type CronResponse,
  maxDuration,
} from '../api/cron-push-digest';
import { subscribers } from '../src/db/schema';

// ---------------------------------------------------------------------------
// Mocks：企微推送（markdown）/ 仓库简介（loadRepoSummaries）/ db 层 / config —— 绝不触网、不连库、不调 LLM。
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  sendWeComMarkdown: vi.fn(),
}));

const summaryMock = vi.hoisted(() => ({
  loadRepoSummaries: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  executeQueries: [] as unknown[],
  executeRows: [] as Record<string, unknown>[],
  selectConditions: [] as unknown[],
  selectRows: [] as unknown[],
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
  sendWeComMarkdown: apiMock.sendWeComMarkdown,
}));

vi.mock('../src/agent/repo-summary', () => ({
  loadRepoSummaries: summaryMock.loadRepoSummaries,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async (query: unknown) => {
      dbMock.executeQueries.push(query);
      return { rows: dbMock.executeRows };
    },
    select: () => ({
      from: () => ({
        where: async (condition: unknown) => {
          dbMock.selectConditions.push(condition);
          return dbMock.selectRows;
        },
      }),
    }),
  }),
}));

vi.mock('../src/config', () => ({
  env: { CRON_SECRET: 'unit-test-cron-secret' },
}));

import {
  DIGEST_FOOTER,
  buildDigestForSubscriber,
  pushDigests,
  shanghaiToday,
} from '../src/agent/digest';

type SubscriberRow = typeof subscribers.$inferSelect;

function makeSub(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: 1,
    wecomUserid: 'alice',
    displayName: 'Alice',
    preferences: { languages: [], keywords: [] },
    githubLogin: null,
    githubTokenEnc: null,
    active: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** 模拟 digest 查询（trending_entries join repos）返回的一行。 */
function makeEntry(
  fullName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    fullName,
    description: `${fullName} 的简介`,
    topics: [],
    stars: 1000,
    starsDelta: 100,
    isNew: false,
    htmlUrl: `https://github.com/${fullName}`,
    ...overrides,
  };
}

/** 把 drizzle SQL 对象编译为文本 + 参数，便于断言（不触库）。 */
function compileQuery(wrapper: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(wrapper as SQL);
}

/** 取 from/join 之后的 where 片段（无 where 时为空串）。 */
function whereFragment(sqlText: string): string {
  const idx = sqlText.indexOf(' where ');
  return idx === -1 ? '' : sqlText.slice(idx);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.executeQueries.length = 0;
  dbMock.executeRows.length = 0;
  dbMock.selectConditions.length = 0;
  dbMock.selectRows.length = 0;
  // 默认：简介降级（空 Map，等价 LLM 失败后的无简介输出），发送全部成功。
  summaryMock.loadRepoSummaries.mockResolvedValue(new Map());
  apiMock.sendWeComText.mockResolvedValue(undefined);
  apiMock.sendWeComMarkdown.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// shanghaiToday —— 北京时间日期（Vercel 运行时为 UTC，直接 toISOString 会错一天）
// ---------------------------------------------------------------------------
describe('shanghaiToday — 北京时间日期', () => {
  it('UTC 16:00（北京次日 00:00）→ 返回北京日期 YYYY-MM-DD', () => {
    expect(shanghaiToday(new Date('2026-10-22T16:00:00Z'))).toBe('2026-10-23');
  });

  it('UTC 15:59:59（北京当日 23:59:59）→ 仍是当日', () => {
    expect(shanghaiToday(new Date('2026-10-22T15:59:59Z'))).toBe('2026-10-22');
  });

  it('格式恒为 en-CA 风格 YYYY-MM-DD', () => {
    expect(shanghaiToday(new Date('2026-01-01T20:00:00Z'))).toBe('2026-01-02');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— 偏好过滤
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — 偏好过滤', () => {
  it('preferences.languages 为空 → 不带语言过滤（全量榜）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).not.toContain('"repos"."language"');
    expect(digest).toContain('a/one');
    expect(digest).toContain('b/two');
  });

  it('preferences 缺失 languages 字段时按全量处理（运行时防御）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: {} as SubscriberRow['preferences'] }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).not.toContain('"repos"."language"');
    expect(digest).toContain('a/one');
  });

  it('preferences.languages 非空 → lower(repos.language) IN 参数化过滤', async () => {
    dbMock.executeRows.push(makeEntry('py/match'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: ['python', 'rust'], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).toMatch(
      /lower\("repos"\."language"\) in \(\$\d+(?:, \$\d+)*\)/,
    );
    expect(compiled.params).toContain('python');
    expect(compiled.params).toContain('rust');
    expect(digest).toContain('py/match');
  });

  it('preferences.languages=["Java"] 经 lowercase 命中仓库真实语言（lower(repos.language) 匹配 "Java"）', async () => {
    dbMock.executeRows.push(makeEntry('jdk/tool'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: ['Java'], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).toMatch(
      /lower\("repos"\."language"\) in \(\$\d+\)/,
    );
    // normalizePreferences 已 lowercase，参数不再二次 lower
    expect(compiled.params).toContain('java');
    expect(digest).toContain('jdk/tool');
  });

  it('周期固定为近 7 天（week），候选池 20 条', async () => {
    await buildDigestForSubscriber(makeSub());

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(compiled.params[0]).toBe(7);
    expect(compiled.sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(compiled.params.at(-1)).toBe(20);
  });

  it('最多取 top 10 条进入简报', async () => {
    for (let i = 1; i <= 12; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('10. [o/r10](https://github.com/o/r10)');
    expect(digest).not.toContain('o/r11');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber — digestCount 用户自定义条数（clamp 1–20，默认 10）
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — digestCount 用户自定义', () => {
  it('preferences.digestCount=3 → 简报恰 3 条', async () => {
    for (let i = 1; i <= 5; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 3 } }),
    );

    expect(digest).toContain('3. [o/r3](https://github.com/o/r3)');
    expect(digest).not.toContain('o/r4');
  });

  it('digestCount=0 → clamp 到下限 1', async () => {
    for (let i = 1; i <= 3; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 0 } }),
    );

    expect(digest).toContain('1. [o/r1](https://github.com/o/r1)');
    expect(digest).not.toContain('o/r2');
  });

  it('digestCount=99 → clamp 到上限 20（成本护栏）', async () => {
    for (let i = 1; i <= 21; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 99 },
      }),
    );

    expect(digest).toContain('20. [o/r20](https://github.com/o/r20)');
    expect(digest).not.toContain('o/r21');
  });

  it('digestCount 为字符串等非法类型 → 回退默认 10', async () => {
    for (let i = 1; i <= 12; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: {
          languages: [],
          keywords: [],
          digestCount: '5' as unknown as number,
        },
      }),
    );

    expect(digest).toContain('10. [o/r10](https://github.com/o/r10)');
    expect(digest).not.toContain('o/r11');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— 头部日期（北京时间）、单行格式、简介注入与降级
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — 简报内容', () => {
  it('头部日期为北京时间：UTC 16:30 推送时日期已是北京次日', async () => {
    dbMock.executeRows.push(makeEntry('vercel/next.js'));

    const digest = await buildDigestForSubscriber(
      makeSub(),
      new Date('2026-10-22T16:30:00Z'),
    );

    expect(digest.startsWith('📊 今日 GitHub 热榜简报（2026-10-23）\n')).toBe(true);
  });

  it('空榜锁定：只有头部 + 占位文案，且不带收藏页脚（无可收藏条目）', async () => {
    // characterization 测试：锁定 assemble 的 EMPTY_NOTICE 分支——
    // 空榜时故意省略 DIGEST_FOOTER（「收藏 N」在无可收藏条目时是误导），
    // 收藏链路写入 search_caches 属 Task 4，届时再统一评估页脚策略。
    const digest = await buildDigestForSubscriber(
      makeSub(),
      new Date('2026-10-22T16:30:00Z'),
    );

    expect(digest).toBe(
      '📊 今日 GitHub 热榜简报（2026-10-23）\n\n今日暂无符合条件的热榜项目。',
    );
    expect(digest).not.toContain(DIGEST_FOOTER);
  });

  it('页脚固定为「💡 回复「收藏 N」…」且位于消息末尾', async () => {
    dbMock.executeRows.push(makeEntry('a/one'));

    const digest = await buildDigestForSubscriber(makeSub());

    expect(DIGEST_FOOTER).toBe(
      '💡 回复「收藏 N」收藏任意一条；发「帮助」查看全部指令',
    );
    expect(digest.endsWith(DIGEST_FOOTER)).toBe(true);
    expect(digest).toContain('收藏');
  });

  it('每条恰好一行（链接 + ★ + 增量 +（新上榜），不再有「为什么上榜」两行块）', async () => {
    dbMock.executeRows.push(
      makeEntry('a/fresh', { isNew: true, starsDelta: 500 }),
      makeEntry('b/veteran', { starsDelta: 800 }),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain(
      '1. [a/fresh](https://github.com/a/fresh) ★1000 (+500)（新上榜）',
    );
    expect(digest).toContain(
      '2. [b/veteran](https://github.com/b/veteran) ★1000 (+800)',
    );
    expect(digest).not.toContain('为什么上榜');
    // 单行纪律：除头部/空行/页脚外，每条条目不产生额外换行
    expect(digest).not.toMatch(/\n\s{2,}\S/);
  });

  it('loadRepoSummaries 注入：命中的仓库行尾追加「 — 中文简介」', async () => {
    dbMock.executeRows.push(
      makeEntry('a/fresh', { starsDelta: 500 }),
      makeEntry('b/veteran', { starsDelta: 800 }),
    );
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map([['a/fresh', '新锐 AI 框架']]),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(summaryMock.loadRepoSummaries).toHaveBeenCalledTimes(1);
    expect(digest).toContain(
      '1. [a/fresh](https://github.com/a/fresh) ★1000 (+500) — 新锐 AI 框架',
    );
    // 未命中的仓库省略破折号后段
    expect(digest).toContain('2. [b/veteran](https://github.com/b/veteran) ★1000 (+800)\n');
  });

  it('简介降级（loadRepoSummaries 返回空 Map）→ 无破折号后段，仍含完整 repo 列表', async () => {
    summaryMock.loadRepoSummaries.mockResolvedValue(new Map());
    dbMock.executeRows.push(
      makeEntry('vercel/next.js', { stars: 128000, starsDelta: 321 }),
      makeEntry('rust-lang/rust', { isNew: true, stars: 99000, starsDelta: 100 }),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain(
      '1. [vercel/next.js](https://github.com/vercel/next.js) ★128000 (+321)',
    );
    expect(digest).toContain(
      '2. [rust-lang/rust](https://github.com/rust-lang/rust) ★99000 (+100)（新上榜）',
    );
    expect(digest).not.toContain(' — ');
    expect(digest).toContain('📊 今日 GitHub 热榜简报（');
  });

  it('loadRepoSummaries 抛错 → 降级输出 repo 列表（摘要失败不吞简报）', async () => {
    summaryMock.loadRepoSummaries.mockRejectedValue(new Error('llm exploded'));
    dbMock.executeRows.push(makeEntry('x/y', { stars: 10, starsDelta: 5 }));

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('1. [x/y](https://github.com/x/y) ★10 (+5)');
  });

  it('超长内容截断到 3800 字节内并标注，首条保留', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`owner${i}/repo-with-a-rather-long-name-${i}`, {
        stars: 123456,
        starsDelta: 2345,
      }),
    );
    dbMock.executeRows.push(...entries);
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map(
        entries.map((e, i) => [
          String(e.fullName),
          `这是一段很长的上榜理由编号${i}，用来撑爆字节上限。`.repeat(4),
        ]),
      ),
    );

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 20 },
      }),
    );

    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(3800);
    expect(digest).toContain('（内容过长，已截断）');
    expect(digest).toContain('owner0/repo-with-a-rather-long-name-0');
    expect(digest).not.toContain('owner19/repo-with-a-rather-long-name-19');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— keywords 轻量生效（提升排序，不丢弃条目）
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — keywords 轻量生效', () => {
  it('命中关键词的条目排到前面，未命中的条目仍保留', async () => {
    dbMock.executeRows.push(
      makeEntry('big/stars', { starsDelta: 900 }),
      makeEntry('ai/agent-kit', { starsDelta: 50, topics: ['ai-agent', 'llm'] }),
    );

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: ['agent'] } }),
    );

    expect(digest.indexOf('ai/agent-kit')).toBeLessThan(
      digest.indexOf('big/stars'),
    );
    expect(digest).toContain('big/stars');
  });

  it('关键词无人命中时保持全量列表（列表绝不因关键词清空）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: [], keywords: ['quantum-blockchain'] },
      }),
    );

    expect(digest).toContain('a/one');
    expect(digest).toContain('b/two');
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 遍历 active 订阅者，单个失败不中断，走 markdown 通道
// ---------------------------------------------------------------------------
describe('pushDigests — 推送计数与容错', () => {
  it('订阅查询按 active = true 过滤', async () => {
    await pushDigests();

    const compiled = compileQuery(dbMock.selectConditions[0]);
    expect(compiled.sql).toMatch(/"subscribers"\."active"\s*=\s*(\$1|true)/);
  });

  it('全部成功 → { sent: n, failed: 0 }，逐个经 sendWeComMarkdown 发送', async () => {
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledTimes(2);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(apiMock.sendWeComMarkdown.mock.calls.map((c) => c[0])).toEqual([
      'alice',
      'bob',
    ]);
    expect(apiMock.sendWeComMarkdown).toHaveBeenLastCalledWith(
      'bob',
      expect.stringContaining('a/one'),
    );
  });

  it('第 2 个订阅者发送抛错时仍处理第 3 个，计数正确', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
      makeSub({ id: 3, wecomUserid: 'carol' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));
    apiMock.sendWeComMarkdown
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('wecom down'))
      .mockResolvedValueOnce(undefined);

    const result = await pushDigests();

    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(apiMock.sendWeComMarkdown.mock.calls.map((c) => c[0])).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(apiMock.sendWeComMarkdown).toHaveBeenLastCalledWith(
      'carol',
      expect.stringContaining('a/one'),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// api/cron-push-digest —— CRON_SECRET 校验
// ---------------------------------------------------------------------------
function mockRes(): CronResponse & {
  statusCode: number;
  body: string | undefined;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 0,
    body: undefined as string | undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res as typeof res & {
    statusCode: number;
    body: string | undefined;
  };
}

function cronReq(auth?: string): CronRequest {
  return {
    method: 'GET',
    headers: auth === undefined ? {} : { authorization: auth },
  };
}

describe('api/cron-push-digest — CRON_SECRET 校验', () => {
  it('无 Authorization 头 → 401 JSON，不做任何推送', async () => {
    const res = mockRes();

    await handler(cronReq(), res);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? '')).toEqual({ error: 'unauthorized' });
    expect(dbMock.selectConditions).toHaveLength(0);
    expect(apiMock.sendWeComMarkdown).not.toHaveBeenCalled();
    expect(summaryMock.loadRepoSummaries).not.toHaveBeenCalled();
  });

  it('secret 错误 → 401，不做任何推送', async () => {
    const res = mockRes();

    await handler(cronReq('Bearer wrong-secret'), res);

    expect(res.statusCode).toBe(401);
    expect(dbMock.selectConditions).toHaveLength(0);
    expect(apiMock.sendWeComMarkdown).not.toHaveBeenCalled();
  });

  it('只有裸 secret 而无 Bearer 前缀 → 401', async () => {
    const res = mockRes();

    await handler(cronReq('unit-test-cron-secret'), res);

    expect(res.statusCode).toBe(401);
    expect(dbMock.selectConditions).toHaveLength(0);
  });

  it('Bearer <CRON_SECRET> 正确 → 执行 pushDigests 并返回 {sent, failed} JSON', async () => {
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));
    const res = mockRes();

    await handler(cronReq('Bearer unit-test-cron-secret'), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({ sent: 2, failed: 0 });
    expect(res.headers['content-type']).toContain('application/json');
    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Vercel Node 函数配置：maxDuration 经 export 生效（不引入 vercel.json）
// ---------------------------------------------------------------------------
describe('api/cron-push-digest — 函数时长上限', () => {
  it('导出 maxDuration = 300（秒；串行简报超过默认上限会尾部丢消息）', () => {
    expect(maxDuration).toBe(300);
  });
});
