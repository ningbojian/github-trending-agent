import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 每日快照：db / llm / repo-summary 全部打桩，绝不触网。
 * env 未在快照模块中使用，无需 mock config。
 */
const dbState = vi.hoisted(() => ({
  cacheRows: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  insertCalls: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  executeRows: [] as unknown[],
  executeCalls: 0,
  executeError: null as Error | null,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...dbState.cacheRows]),
      }),
    }),
    insert: () => ({
      values: (values: { key: string; value: unknown; expiresAt: Date }) => {
        dbState.insertCalls.push(values);
        return {
          onConflictDoUpdate: async () => {
            // 模拟真实库：写入后后续 select 能读到（用于验证第二次调用命中缓存）。
            dbState.cacheRows = [
              ...dbState.cacheRows.filter((row) => row.key !== values.key),
              values,
            ];
          },
        };
      },
    }),
    execute: async () => {
      dbState.executeCalls += 1;
      if (dbState.executeError) throw dbState.executeError;
      return { rows: [...dbState.executeRows] };
    },
  }),
}));

const llmState = vi.hoisted(() => ({
  abstract: null as string | null,
  fail: false,
  prompts: [] as string[],
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: async (_schema: unknown, prompt: string) => {
    llmState.prompts.push(prompt);
    if (llmState.fail) throw new Error('llm down');
    return llmState.abstract === null ? null : { abstract: llmState.abstract };
  },
}));

const summaryState = vi.hoisted(() => ({
  summaries: new Map<string, string>(),
  /** 命中该 fullName 的批次抛错（模拟批间失败）。 */
  failFor: new Set<string>(),
  calls: [] as string[][],
}));

vi.mock('../src/agent/repo-summary', () => ({
  loadRepoSummaries: async (items: Array<{ fullName: string }>) => {
    summaryState.calls.push(items.map((item) => item.fullName));
    if (items.some((item) => summaryState.failFor.has(item.fullName))) {
      throw new Error('summary batch failed');
    }
    const out = new Map<string, string>();
    for (const item of items) {
      const zh = summaryState.summaries.get(item.fullName);
      if (zh !== undefined) out.set(item.fullName, zh);
    }
    return out;
  },
}));

import {
  composeCandidatesSql,
  getDailySnapshot,
  selectEntriesForPreferences,
  selectSnapshotPool,
  type DigestSnapshotItem,
} from '../src/agent/digest-snapshot';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const NOW = new Date('2026-10-25T01:00:00Z'); // 北京时间 09:00

function row(fullName: string, overrides: Record<string, unknown> = {}) {
  return {
    fullName,
    description: `${fullName} 的描述`,
    topics: ['ai'],
    language: 'TypeScript',
    stars: 1000,
    starsDelta: 100,
    isNew: false,
    htmlUrl: `https://github.com/${fullName}`,
    dataDate: '2026-10-25',
    ...overrides,
  };
}

function item(
  fullName: string,
  overrides: Partial<DigestSnapshotItem> = {},
): DigestSnapshotItem {
  return {
    fullName,
    description: null,
    topics: [],
    language: 'typescript',
    stars: 1,
    starsDelta: 1,
    isNew: false,
    htmlUrl: `https://github.com/${fullName}`,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.cacheRows = [];
  dbState.insertCalls = [];
  dbState.executeRows = [];
  dbState.executeCalls = 0;
  dbState.executeError = null;
  llmState.abstract = '今天的榜单集中在 AI 工具与开发效率上。';
  llmState.fail = false;
  llmState.prompts = [];
  summaryState.summaries = new Map();
  summaryState.failFor = new Set();
  summaryState.calls = [];
});

describe('getDailySnapshot', () => {
  it('builds from the 7-day candidate pool and attaches Chinese summaries', async () => {
    dbState.executeRows = [row('a/one'), row('b/two', { language: 'Rust' })];
    summaryState.summaries.set('a/one', '第一个项目。');

    const snapshot = await getDailySnapshot(NOW);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.date).toBe('2026-10-25');
    expect(snapshot?.abstract).toBe(llmState.abstract);
    expect(snapshot?.items.map((entry) => entry.fullName)).toEqual([
      'a/one',
      'b/two',
    ]);
    expect(snapshot?.items[0].summary).toBe('第一个项目。');
    expect(snapshot?.items[1].summary).toBeUndefined();
    expect(summaryState.calls).toEqual([['a/one', 'b/two']]);
  });

  it('writes the snapshot to kv_cache under digest-snapshot:<date>', async () => {
    dbState.executeRows = [row('a/one')];
    await getDailySnapshot(NOW);

    expect(dbState.insertCalls).toHaveLength(1);
    const written = dbState.insertCalls[0];
    expect(written.key).toBe('digest-snapshot:2026-10-25');
    const ttl = written.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect((written.value as { date: string }).date).toBe('2026-10-25');
  });

  it('reuses the cached snapshot while the source data has not changed', async () => {
    dbState.executeRows = [row('a/one')];
    const first = await getDailySnapshot(NOW);
    const second = await getDailySnapshot(NOW);

    // 当日快照每次都会读一次候选池（用于校验 dataDate），但命中后不重建。
    expect(dbState.executeCalls).toBe(2);
    expect(dbState.insertCalls).toHaveLength(1);
    expect(summaryState.calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('rebuilds once the day’s scrape lands later in the day', async () => {
    // 北京 00:00 的 tick 先缓存了一份基于「昨天数据」的快照；08:30 抓取落库后，
    // 09:00 的 tick 必须发现 dataDate 变了并重建，否则全天都在发昨天的榜。
    dbState.cacheRows = [
      {
        key: 'digest-snapshot:2026-10-25',
        value: {
          date: '2026-10-25',
          dataDate: '2026-10-24',
          abstract: null,
          items: [item('stale/repo')],
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];
    dbState.executeRows = [row('a/one')];

    const snapshot = await getDailySnapshot(NOW);

    expect(snapshot?.dataDate).toBe('2026-10-25');
    expect(snapshot?.items.map((entry) => entry.fullName)).toEqual(['a/one']);
    expect(dbState.insertCalls).toHaveLength(1);
    expect(summaryState.calls).toHaveLength(1);
  });

  it('keeps the cache when the data date matches', async () => {
    dbState.cacheRows = [
      {
        key: 'digest-snapshot:2026-10-25',
        value: {
          date: '2026-10-25',
          dataDate: '2026-10-25',
          abstract: '旧概览。',
          items: [item('cached/repo')],
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];
    dbState.executeRows = [row('a/one')];

    const snapshot = await getDailySnapshot(NOW);

    expect(snapshot?.items.map((entry) => entry.fullName)).toEqual(['cached/repo']);
    expect(dbState.insertCalls).toHaveLength(0);
    expect(summaryState.calls).toHaveLength(0);
  });

  it('ignores an expired cache entry', async () => {
    dbState.cacheRows = [
      {
        key: 'digest-snapshot:2026-10-25',
        value: { date: '2026-10-25', abstract: null, items: [item('old/repo')] },
        expiresAt: new Date(Date.now() - 1000),
      },
    ];
    dbState.executeRows = [row('a/one')];

    const snapshot = await getDailySnapshot(NOW);
    expect(dbState.executeCalls).toBe(1);
    expect(snapshot?.items.map((entry) => entry.fullName)).toEqual(['a/one']);
  });

  it('ignores a cache value whose date does not match the key day', async () => {
    dbState.cacheRows = [
      {
        key: 'digest-snapshot:2026-10-25',
        value: { date: '2026-10-24', abstract: null, items: [item('old/repo')] },
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    dbState.executeRows = [row('a/one')];

    const snapshot = await getDailySnapshot(NOW);
    expect(dbState.executeCalls).toBe(1);
    expect(snapshot?.items.map((entry) => entry.fullName)).toEqual(['a/one']);
  });

  it('returns a snapshot but does not cache an empty pool', async () => {
    dbState.executeRows = [];
    const snapshot = await getDailySnapshot(NOW);

    expect(snapshot).toEqual({
      date: '2026-10-25',
      dataDate: null,
      abstract: llmState.abstract,
      items: [],
    });
    expect(dbState.insertCalls).toHaveLength(0);
  });

  it('returns null when the candidate query fails (caller falls back)', async () => {
    dbState.executeError = new Error('neon down');
    const snapshot = await getDailySnapshot(NOW);
    expect(snapshot).toBeNull();
    expect(dbState.insertCalls).toHaveLength(0);
  });

  it('omits the abstract and still sends when the abstract call fails', async () => {
    dbState.executeRows = [row('a/one')];
    llmState.fail = true;

    const snapshot = await getDailySnapshot(NOW);
    expect(snapshot?.abstract).toBeNull();
    expect(snapshot?.items).toHaveLength(1);
  });

  it('keeps the snapshot when a summary batch fails', async () => {
    dbState.executeRows = [row('a/one'), row('b/two')];
    summaryState.summaries.set('a/one', '第一个项目。');
    // 两条同批（SUMMARY_BATCH=40）→ 该批整体失败：简介全部缺失，
    // 但快照本身仍返回（简报降级为无简介，绝不因此不发）。
    summaryState.failFor.add('b/two');

    const snapshot = await getDailySnapshot(NOW);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.items).toHaveLength(2);
    expect(snapshot?.items.every((entry) => entry.summary === undefined)).toBe(
      true,
    );
    expect(snapshot?.abstract).toBe(llmState.abstract);
  });

  it('truncates the abstract to 80 code points', async () => {
    dbState.executeRows = [row('a/one')];
    llmState.abstract = '今'.repeat(120);

    const snapshot = await getDailySnapshot(NOW);
    expect(Array.from(snapshot?.abstract ?? '')).toHaveLength(80);
  });
});

describe('composeCandidatesSql', () => {
  it('selects the global top 20 plus each language’s top 15 in SQL', () => {
    // 只在 SQL 里按全局 delta 截断会让小语种整榜进不了候选池（语言偏好为空的
    // 订阅者因此收到 0 条）。这里钉住：语言榜的 15 条在 SQL 里单独排名并保留。
    const compiled = new PgDialect().sqlToQuery(composeCandidatesSql() as SQL);
    const text = compiled.sql.replace(/\s+/g, ' ');
    expect(text).toContain('row_number() over (partition by lower("language")');
    expect(text).toContain('max("entryDate") over ()');
    expect(text).toMatch(/global_rank <= \$?\d+ or language_rank <= \$?\d+/);
  });
});

describe('selectSnapshotPool', () => {
  it('keeps the global top 20 plus each language top 20, deduped', () => {
    const candidates = [
      ...Array.from({ length: 30 }, (_, index) =>
        item(`global/${index}`, { language: 'typescript' }),
      ),
      ...Array.from({ length: 25 }, (_, index) =>
        item(`rust/${index}`, { language: 'rust' }),
      ),
    ];

    const picked = selectSnapshotPool(candidates);
    const names = picked.map((entry) => entry.fullName);

    expect(names.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, index) => `global/${index}`),
    );
    // 语言榜 top 20：typescript 的前 20 已在前 20 中，rust 补 20 条。
    // 与邮箱可选的最大条数（20）对齐，避免「要 20 条只给 15 条」。
    expect(names).toHaveLength(40);
    expect(names.filter((name) => name.startsWith('rust/'))).toEqual(
      Array.from({ length: 20 }, (_, index) => `rust/${index}`),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('ignores entries without a language for the per-language pass', () => {
    const candidates = [
      ...Array.from({ length: 20 }, (_, index) => item(`global/${index}`)),
      ...Array.from({ length: 5 }, (_, index) =>
        item(`no-lang/${index}`, { language: null }),
      ),
    ];
    const names = selectSnapshotPool(candidates).map((entry) => entry.fullName);
    expect(names).toHaveLength(20);
  });
});

describe('selectEntriesForPreferences', () => {
  const items = [
    item('a/ai-one', { language: 'python', description: 'LLM toolkit' }),
    item('b/web', { language: 'typescript', topics: ['react'] }),
    item('c/rust-ai', { language: 'rust', topics: ['ai'] }),
    item('d/other', { language: 'go' }),
  ];

  it('returns the same order when no preferences are set', () => {
    expect(
      selectEntriesForPreferences(items, {}).map((entry) => entry.fullName),
    ).toEqual(['a/ai-one', 'b/web', 'c/rust-ai', 'd/other']);
  });

  it('filters by language (case-insensitive, unknown values ignored)', () => {
    const picked = selectEntriesForPreferences(items, {
      languages: ['PYTHON', 'Rust', 'brainfuck'],
    });
    expect(picked.map((entry) => entry.fullName)).toEqual([
      'a/ai-one',
      'c/rust-ai',
    ]);
  });

  it('ranks keyword matches first without dropping the rest', () => {
    const picked = selectEntriesForPreferences(items, { keywords: 'ai' });
    expect(picked.map((entry) => entry.fullName)).toEqual([
      'a/ai-one',
      'c/rust-ai',
      'b/web',
      'd/other',
    ]);
  });

  it('cleans punctuation and lowercases keywords', () => {
    // 「AI！」清洗成 ai：命中 a/ai-one 与 c/rust-ai，其余保持原序。
    const picked = selectEntriesForPreferences(items, { keywords: 'AI！' });
    expect(picked.slice(0, 2).map((entry) => entry.fullName)).toEqual([
      'a/ai-one',
      'c/rust-ai',
    ]);
    // 大小写与首尾空白同样清洗：React → react 命中 b/web 的 topics。
    const react = selectEntriesForPreferences(items, { keywords: ' React ' });
    expect(react[0].fullName).toBe('b/web');
  });

  it('applies language filtering before keyword ranking', () => {
    const picked = selectEntriesForPreferences(items, {
      languages: ['typescript', 'go'],
      keywords: 'ai',
    });
    expect(picked.map((entry) => entry.fullName)).toEqual(['b/web', 'd/other']);
  });

  it('clamps digestCount to 1–20 and falls back on non-numbers', () => {
    const many = Array.from({ length: 25 }, (_, index) => item(`r/${index}`));
    expect(selectEntriesForPreferences(many, { digestCount: 20 })).toHaveLength(20);
    expect(selectEntriesForPreferences(many, { digestCount: 99 })).toHaveLength(20);
    expect(selectEntriesForPreferences(many, { digestCount: 0 })).toHaveLength(1);
    expect(selectEntriesForPreferences(many, { digestCount: 'x' })).toHaveLength(10);
    expect(
      selectEntriesForPreferences(many, {}, 15),
    ).toHaveLength(15);
  });
});
