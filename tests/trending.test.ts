import { readFileSync } from 'node:fs';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repos, trendingEntries } from '../src/db/schema';
import { SCRAPER_LANGUAGES } from '../src/config';

/** 把 drizzle SQL 片段编译为 { sql, params }（与其余测试文件的 compileQuery 同形）。 */
function compileQuery(wrapper: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(wrapper as SQL);
}

/**
 * 真实页面快照（2026-10-22 抓取 https://github.com/trending?since=daily）。
 * 注意：GitHub 现在的 daily 总榜每页只给 12~15 条（旧 brief 里写的"≥ 25"已过时），
 * 因此断言以 fixture 中 article.Box-row 的实际数量为准。
 */
const fixtureHtml = readFileSync(
  new URL('./fixtures/trending-daily.html', import.meta.url),
  'utf8',
);
const fixtureArticleCount = (
  fixtureHtml.match(/<article class="Box-row">/g) ?? []
).length;

// 单条合成条目：用于验证 weekly 周期标签与 "New" 徽标，fixture 里恰好没有这两种情况。
function syntheticArticle({
  deltaLabel,
  newBadge,
}: {
  deltaLabel: string;
  newBadge?: boolean;
}): string {
  return `<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a href="/acme/widget">${newBadge ? '<span class="Label Label--accent">New</span>' : ''}acme / widget</a>
  </h2>
  <p class="col-9 color-fg-muted my-1 pr-4">A test widget &amp; friends.</p>
  <span itemprop="programmingLanguage">Rust</span>
  <a href="/acme/widget/stargazers">1,234</a>
  <span class="d-inline-block float-sm-right">${deltaLabel}</span>
</article>`;
}

// 仅导入 parseTrendingHtml；scrapeAndUpsert 的单测在下方 describe 中再动态导入，
// 以便先安装 fetch / db mock。
const { parseTrendingHtml, scrapeAndUpsert } = await import(
  '../src/scraper/trending'
);

describe('parseTrendingHtml（真实 daily 快照）', () => {
  it('解析出 fixture 中全部条目（GitHub 当前每页 12~15 条，brief 里的 ≥25 已过时）', () => {
    const parsed = parseTrendingHtml(fixtureHtml, 'daily');
    expect(parsed).toHaveLength(fixtureArticleCount);
    expect(parsed.length).toBeGreaterThanOrEqual(10);
  });

  it('首条的 fullName / owner / name / rank / stars / starsDelta 正确', () => {
    const [first] = parseTrendingHtml(fixtureHtml, 'daily');
    expect(first.fullName).toBe('MadsLorentzen/ai-job-search');
    expect(first.owner).toBe('MadsLorentzen');
    expect(first.name).toBe('ai-job-search');
    expect(first.rank).toBe(1);
    expect(first.stars).toBe(62662);
    expect(first.starsDelta).toBe(3131);
    expect(first.language).toBe('Python');
    expect(first.description).toContain('The job search that runs on your machine');
  });

  it('rank 连续且 fullName 唯一、形如 owner/name', () => {
    const parsed = parseTrendingHtml(fixtureHtml, 'daily');
    expect(parsed.map((r) => r.rank)).toEqual(
      parsed.map((_, i) => i + 1),
    );
    expect(new Set(parsed.map((r) => r.fullName)).size).toBe(parsed.length);
    for (const repo of parsed) {
      expect(repo.fullName).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it('isNew 与页面上的 New 徽标（Label--accent）数量一致', () => {
    const newBadgeCount = (fixtureHtml.match(/Label--accent/g) ?? []).length;
    const parsed = parseTrendingHtml(fixtureHtml, 'daily');
    expect(parsed.filter((r) => r.isNew)).toHaveLength(newBadgeCount);
    // 本快照里没有任何 New 徽标，因此全部为 false。
    expect(parsed.every((r) => r.isNew === false)).toBe(true);
  });

  it('weekly 周期解析 "N stars today" 之外的周标签', () => {
    const html = syntheticArticle({
      deltaLabel: '567 stars this week',
      newBadge: true,
    });
    const [repo] = parseTrendingHtml(html, 'weekly');
    expect(repo.fullName).toBe('acme/widget');
    expect(repo.starsDelta).toBe(567);
    expect(repo.isNew).toBe(true);
    expect(repo.language).toBe('Rust');
    // 日榜解析同一页面时找不到周标签，delta 归 0。
    expect(parseTrendingHtml(html, 'daily')[0]?.starsDelta).toBe(0);
  });

  it('描述中的 HTML 实体被解码', () => {
    const html = syntheticArticle({ deltaLabel: '10 stars today' });
    expect(parseTrendingHtml(html, 'daily')[0]?.description).toBe(
      'A test widget & friends.',
    );
  });
});

describe('parseTrendingHtml（边界情况）', () => {
  it('空字符串返回 []', () => {
    expect(parseTrendingHtml('', 'daily')).toEqual([]);
  });

  it('改版后的怪页面（无 article.Box-row）返回 []', () => {
    expect(parseTrendingHtml('<html>改版后的怪页面</html>', 'daily')).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// scrapeAndUpsert：mock 全局 fetch 与 db()，纯单测，不碰网络与数据库。
// ---------------------------------------------------------------------------

interface InsertCall {
  table: unknown;
  values?: Record<string, unknown>;
  conflict?: {
    target?: unknown;
    set?: Record<string, unknown>;
  };
}

const insertLog = vi.hoisted(() => [] as InsertCall[]);

vi.mock('../src/db/client', () => ({
  db: () => ({
    insert: (table: unknown) => {
      const call: InsertCall = { table };
      const chain = {
        values(values: Record<string, unknown>) {
          call.values = values;
          return chain;
        },
        onConflictDoUpdate(config: InsertCall['conflict']) {
          call.conflict = config;
          return chain;
        },
      };
      insertLog.push(call);
      return chain;
    },
  }),
}));

describe('scrapeAndUpsert（fetch + db mock）', () => {
  let fetchedUrls: string[];

  beforeEach(() => {
    insertLog.length = 0;
    fetchedUrls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, text: async () => fixtureHtml };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function entryInserts() {
    return insertLog.filter((c) => c.table === trendingEntries);
  }

  function repoInserts() {
    return insertLog.filter((c) => c.table === repos);
  }

  it('SCRAPER_LANGUAGES 覆盖 19 种语言（保留原 5 种）', () => {
    expect([...SCRAPER_LANGUAGES]).toEqual([
      'python',
      'typescript',
      'javascript',
      'go',
      'rust',
      'java',
      'c',
      'c++',
      'c#',
      'php',
      'ruby',
      'swift',
      'kotlin',
      'dart',
      'shell',
      'html',
      'css',
      'vue',
      'lua',
    ]);
  });

  it('抓取总榜 + 每个 SCRAPER_LANGUAGES 语言页（since=daily，语言 slug 经 encodeURIComponent 编码）', async () => {
    const result = await scrapeAndUpsert();
    expect(fetchedUrls).toEqual([
      'https://github.com/trending?since=daily',
      ...SCRAPER_LANGUAGES.map(
        (lang) =>
          `https://github.com/trending/${encodeURIComponent(lang)}?since=daily`,
      ),
    ]);
    expect(result).toEqual({
      inserted: fixtureArticleCount * (SCRAPER_LANGUAGES.length + 1),
      languages: SCRAPER_LANGUAGES.length + 1,
    });
  });

  it('含 + / # 的语言 slug 被编码（c++ → c%2B%2B、c# → c%23，# 原样会变成 fragment）', async () => {
    await scrapeAndUpsert();
    expect(fetchedUrls).toContain(
      'https://github.com/trending/c%2B%2B?since=daily',
    );
    expect(fetchedUrls).toContain(
      'https://github.com/trending/c%23?since=daily',
    );
    expect(fetchedUrls.some((url) => url.includes('c++') || url.includes('c#'))).toBe(
      false,
    );
  });

  it('总榜条目的 language 为哨兵值 "all"（绝不为 null），语言页用真实语言 slug', async () => {
    await scrapeAndUpsert();
    const entries = entryInserts();
    expect(entries).toHaveLength(
      fixtureArticleCount * (SCRAPER_LANGUAGES.length + 1),
    );
    const byLanguage = new Map<string, typeof entries>();
    for (const call of entries) {
      const lang = call.values?.['language'] as string;
      byLanguage.set(lang, [...(byLanguage.get(lang) ?? []), call]);
    }
    expect([...byLanguage.keys()].sort()).toEqual(
      ['all', ...SCRAPER_LANGUAGES].sort(),
    );
    for (const lang of SCRAPER_LANGUAGES) {
      expect(byLanguage.get(lang)).toHaveLength(fixtureArticleCount);
    }
  });

  it('trending_entries 写入当日快照并以 (date, period, language, full_name) 幂等 upsert', async () => {
    await scrapeAndUpsert();
    const today = new Date().toISOString().slice(0, 10);
    for (const call of entryInserts()) {
      expect(call.values?.['date']).toBe(today);
      expect(call.values?.['period']).toBe('daily');
      expect(call.values?.['source']).toMatch(
        /^https:\/\/github\.com\/trending/,
      );
      expect(call.conflict?.target).toEqual([
        trendingEntries.date,
        trendingEntries.period,
        trendingEntries.language,
        trendingEntries.fullName,
      ]);
      expect(call.conflict?.set).toMatchObject({
        rank: expect.any(Number),
        starsAtCapture: expect.any(Number),
        starsDelta: expect.any(Number),
        isNew: expect.any(Boolean),
      });
    }
    const overall = entryInserts().filter((c) => c.values?.['language'] === 'all');
    expect(overall[0]?.values).toMatchObject({
      fullName: 'MadsLorentzen/ai-job-search',
      rank: 1,
      starsAtCapture: 62662,
      starsDelta: 3131,
      isNew: false,
    });
  });

  it('repos 表按 full_name upsert，topics 置空数组（页面无 topics）', async () => {
    await scrapeAndUpsert();
    const reposUpserts = repoInserts();
    expect(reposUpserts).toHaveLength(
      fixtureArticleCount * (SCRAPER_LANGUAGES.length + 1),
    );
    for (const call of reposUpserts) {
      expect(call.conflict?.target).toEqual(repos.fullName);
      expect(call.values?.['topics']).toEqual([]);
      expect(call.values?.['htmlUrl']).toMatch(/^https:\/\/github\.com\//);
    }
    expect(reposUpserts[0]?.values).toMatchObject({
      fullName: 'MadsLorentzen/ai-job-search',
      name: 'ai-job-search',
      owner: 'MadsLorentzen',
      language: 'Python',
      stars: 62662,
    });
  });

  it('repos 冲突更新集用 coalesce 保留已有 description/language（页面漂移 null 不再清空 enrich 补全的字段）', async () => {
    // 无描述、无语言的页面条目：incoming description/language 均为 null。
    const nullEnrichedHtml = `<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a href="/acme/no-desc-lang">acme / no-desc-lang</a>
  </h2>
  <a href="/acme/no-desc-lang/stargazers">1,000</a>
  <span class="d-inline-block float-sm-right">7 stars today</span>
</article>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, text: async () => nullEnrichedHtml };
      }),
    );

    await scrapeAndUpsert();

    const call = repoInserts().find(
      (c) => c.values?.['fullName'] === 'acme/no-desc-lang',
    );
    expect(call).toBeTruthy();
    // 写入值本身仍是 null（页面没给就是 null），断言的是冲突更新集的保留语义。
    expect(call?.values?.['description']).toBeNull();
    expect(call?.values?.['language']).toBeNull();
    expect(call?.conflict?.target).toEqual(repos.fullName);

    const set = call?.conflict?.set ?? {};
    // coalesce(excluded.x, repos.x)：incoming 为 null 时保留行内已有值（enrich 补全过），
    // 非 null 时仍以页面值覆盖。
    const descriptionSql = compileQuery(set['description']).sql.toLowerCase();
    expect(descriptionSql).toContain('coalesce');
    expect(descriptionSql).toContain('excluded.description');
    expect(descriptionSql).toContain('"repos"."description"');
    const languageSql = compileQuery(set['language']).sql.toLowerCase();
    expect(languageSql).toContain('coalesce');
    expect(languageSql).toContain('excluded.language');
    expect(languageSql).toContain('"repos"."language"');
    // stars 仍直接覆盖为页面最新值（不参与 coalesce）。
    expect(set['stars']).toBe(1000);
  });

  it('单页失败时跳过该页继续，其余页照常入库', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        if (url.includes('/python')) {
          return { ok: false, status: 500, text: async () => '' };
        }
        return { ok: true, status: 200, text: async () => fixtureHtml };
      }),
    );
    const result = await scrapeAndUpsert();
    expect(result).toEqual({
      inserted: fixtureArticleCount * SCRAPER_LANGUAGES.length,
      languages: SCRAPER_LANGUAGES.length,
    });
  });

  it('全部页面失败时返回 inserted=0、languages=0，且不写库（触发 CLI exit 1 的前提）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        throw new Error(`network down: ${url}`);
      }),
    );
    const result = await scrapeAndUpsert();
    expect(result).toEqual({ inserted: 0, languages: 0 });
    expect(insertLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// run-scraper CLI：inserted === 0 必须 exit 1（Actions 失败告警信号）。
// ---------------------------------------------------------------------------

describe('run-scraper CLI 失败信号', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../src/scraper/trending');
  });

  async function loadMainWithResult(result: {
    inserted: number;
    languages: number;
  }) {
    vi.resetModules();
    vi.doMock('../src/scraper/trending', () => ({
      scrapeAndUpsert: async () => result,
    }));
    const mod = await import('../src/scraper/run-scraper');
    return mod.main;
  }

  it('inserted 为 0 时 process.exit(1)', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const main = await loadMainWithResult({ inserted: 0, languages: 0 });
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('inserted 大于 0 时不退出', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const main = await loadMainWithResult({ inserted: 13, languages: 6 });
    await main();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
