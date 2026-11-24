import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawOpportunityFact } from '../src/opportunities/types';

const dbMock = vi.hoisted(() => ({
  kvRows: [] as Array<Record<string, unknown>>,
  sourceRows: [] as Array<Record<string, unknown>>,
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  failSelect: false,
}));

vi.mock('../src/db/client', async () => {
  const { kvCache } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (dbMock.failSelect) throw new Error('db down');
            const rows = table === kvCache ? dbMock.kvRows : dbMock.sourceRows;
            return Promise.resolve([...rows]);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: unknown) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              dbMock.insertCalls.push({ table, values });
              return [{ key: (values as { key?: string }).key ?? '' }];
            },
          }),
          onConflictDoUpdate: async () => {
            dbMock.insertCalls.push({ table, values });
          },
        }),
      }),
      delete: () => ({
        where: async () => undefined,
      }),
    }),
  };
});

import {
  buildOpportunityPool,
  poolKey,
  readLatestOpportunityPool,
  readOpportunityPool,
  type OpportunityPool,
} from '../src/opportunities/pool';

const NOW = new Date('2026-11-18T02:00:00.000Z');

function fact(overrides: Partial<RawOpportunityFact> = {}): RawOpportunityFact {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤：...',
    url: 'https://github.com/acme/agent/issues/12',
    language: 'typescript',
    topics: ['agent'],
    stars: 500,
    license: 'MIT',
    archived: false,
    pushedAt: '2026-11-10T00:00:00.000Z',
    labels: ['good first issue'],
    comments: 3,
    reactions: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    maintainerEngaged: true,
    assigned: false,
    linkedPr: false,
    repoDescription: 'agent toolkit',
    ...overrides,
  };
}

function pool(overrides: Partial<OpportunityPool> = {}): OpportunityPool {
  return {
    version: 1,
    date: '2026-11-18',
    dataDate: '2026-11-18',
    generatedAt: NOW.toISOString(),
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.kvRows = [];
  dbMock.sourceRows = [];
  dbMock.insertCalls = [];
  dbMock.failSelect = false;
});

describe('readOpportunityPool', () => {
  it('旧池缺仓库描述时用 repos + repo-zh 缓存补上第一行', async () => {
    dbMock.kvRows = [
      {
        value: pool({
          items: [
            {
              ...fact(),
              repoDescription: undefined,
              score: 80,
              why: '值得修。',
              firstStep: '复现并认领。',
              effort: '小',
              confidence: '高',
              evidence: [],
            },
          ],
        }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
      {
        key: 'repo-zh:acme/agent',
        value: { zh: '智能体工具库', src: 'agent toolkit' },
        // loadRepoSummaries 内部用 Date.now() 校验缓存，测试里给真实未来时间。
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];
    dbMock.sourceRows = [
      { fullName: 'acme/agent', description: 'agent toolkit' },
    ];

    const loaded = await readOpportunityPool(NOW);

    expect(loaded?.items[0]).toMatchObject({
      repoDescription: 'agent toolkit',
      repoSummary: '智能体工具库',
    });
  });

  it('读取当天有效池', async () => {
    dbMock.kvRows = [
      {
        value: pool({ items: [] }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    ];
    await expect(readOpportunityPool(NOW)).resolves.toMatchObject({
      version: 1,
      date: '2026-11-18',
    });
  });

  it('过期/形状错误/查询失败返回 null', async () => {
    dbMock.kvRows = [
      { value: pool(), expiresAt: new Date(NOW.getTime() - 60_000) },
    ];
    await expect(readOpportunityPool(NOW)).resolves.toBeNull();

    dbMock.kvRows = [{ value: { version: 0 }, expiresAt: new Date(NOW.getTime() + 60_000) }];
    await expect(readOpportunityPool(NOW)).resolves.toBeNull();

    dbMock.failSelect = true;
    await expect(readOpportunityPool(NOW)).resolves.toBeNull();
  });

  it('当天池缺失时回退到最近 2 天的池', async () => {
    dbMock.kvRows = [
      {
        value: pool({ date: '2026-11-17' }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    ];
    await expect(readLatestOpportunityPool(NOW)).resolves.toMatchObject({
      date: '2026-11-17',
    });
  });

  it('当天池存在时优先用当天', async () => {
    dbMock.kvRows = [
      {
        value: pool({ date: '2026-11-18' }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
      {
        value: pool({ date: '2026-11-17' }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    ];
    await expect(readLatestOpportunityPool(NOW)).resolves.toMatchObject({
      date: '2026-11-18',
    });
  });
});

describe('buildOpportunityPool', () => {
  const deps = {
    claim: async () => true,
    release: async () => {},
    repoSummaries: async () => new Map<string, string>(),
  };

  it('池条目带上仓库简介，供卡片第一行使用', async () => {
    const result = await buildOpportunityPool(NOW, {
      ...deps,
      readRawFacts: async () => [fact()],
      repoSummaries: async () => new Map([['acme/agent', '智能体工具库']]),
    });

    expect(result.pool?.items[0]?.repoSummary).toBe('智能体工具库');
    expect(result.pool?.items[0]?.repoDescription).toBe('agent toolkit');
  });

  it('当天已有池 → 直接返回，不重建、不再调 LLM', async () => {
    dbMock.kvRows = [
      {
        value: pool({ items: [] }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    ];
    const readRawFacts = vi.fn(async () => [fact()]);

    const result = await buildOpportunityPool(NOW, {
      ...deps,
      readRawFacts,
    });

    expect(result.pool?.items).toEqual([]);
    expect(readRawFacts).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toEqual([]);
  });

  it('force=true 时跳过已有池并重建', async () => {
    dbMock.kvRows = [
      {
        value: pool({ items: [] }),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    ];
    const readRawFacts = vi.fn(async () => [fact()]);

    const result = await buildOpportunityPool(NOW, {
      ...deps,
      force: true,
      readRawFacts,
    });

    expect(readRawFacts).toHaveBeenCalledTimes(1);
    expect(result.pool?.items).toHaveLength(1);
    expect(dbMock.insertCalls).not.toEqual([]);
  });

  it('选择、合成并写入当天池', async () => {
    const facts = [
      fact(),
      fact({ id: 'contribute:acme/agent#13', issueNumber: 13 }),
      fact({
        id: 'research:acme/agent#9',
        kind: 'research',
        issueNumber: 9,
        labels: ['RFC'],
        assigned: true,
      }),
    ];

    const result = await buildOpportunityPool(NOW, {
      ...deps,
      readRawFacts: async () => facts,
    });

    expect(result.pool?.items).toHaveLength(3);
    expect(result.pool?.date).toBe('2026-11-18');
    expect(result.pool?.items[0]).toMatchObject({
      repo: 'acme/agent',
      why: expect.any(String),
      firstStep: expect.any(String),
    });
    expect(dbMock.insertCalls.some((call) => call.table !== undefined)).toBe(
      true,
    );
  });

  it('池最多 20 填坑 + 10 研究', async () => {
    const facts = [
      ...Array.from({ length: 25 }, (_, index) =>
        fact({
          id: `contribute:acme/c${index}#${index + 1}`,
          repo: `acme/c${index}`,
          issueNumber: index + 1,
        }),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        fact({
          id: `research:acme/r${index}#${index + 100}`,
          kind: 'research',
          repo: `acme/r${index}`,
          issueNumber: index + 100,
          labels: ['RFC'],
          assigned: true,
        }),
      ),
    ];

    const result = await buildOpportunityPool(NOW, {
      ...deps,
      readRawFacts: async () => facts,
    });

    expect(
      result.pool?.items.filter((item) => item.kind === 'contribute'),
    ).toHaveLength(20);
    expect(
      result.pool?.items.filter((item) => item.kind === 'research'),
    ).toHaveLength(10);
  });

  it('没有原始数据返回 no-data', async () => {
    const result = await buildOpportunityPool(NOW, {
      ...deps,
      readRawFacts: async () => [],
    });
    expect(result).toEqual({ pool: null, reason: 'no-data' });
  });

  it('抢不到锁返回 locked，不写池', async () => {
    const result = await buildOpportunityPool(NOW, {
      claim: async () => false,
      release: async () => {},
      readRawFacts: async () => [fact()],
    });
    expect(result).toEqual({ pool: null, reason: 'locked' });
    expect(dbMock.insertCalls).toEqual([]);
  });

  it('LLM 失败时保留模板文案', async () => {
    const result = await buildOpportunityPool(NOW, {
      ...deps,
      readRawFacts: async () => [fact()],
      summarize: async () => {
        throw new Error('llm down');
      },
    });
    expect(result.pool?.items[0]?.why.length).toBeGreaterThan(0);
    expect(result.pool?.items[0]?.firstStep.length).toBeGreaterThan(0);
  });

  it('从 source_items 行重建事实', async () => {
    dbMock.sourceRows = [
      {
        sourceId: 'contribute:acme/agent#12',
        title: 'Windows 下 CUDA 检测失败',
        url: 'https://github.com/acme/agent/issues/12',
        description: '复现步骤：...',
        topics: ['agent'],
        metrics: { stars: 500, comments: 3, reactions: 2 },
        raw: {
          kind: 'contribute',
          repo: 'acme/agent',
          issueNumber: 12,
          labels: ['good first issue'],
          language: 'typescript',
          license: 'MIT',
          archived: false,
          pushedAt: '2026-11-10T00:00:00.000Z',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-16T00:00:00.000Z',
          maintainerEngaged: true,
          assigned: false,
          linkedPr: false,
        },
      },
    ];

    const result = await buildOpportunityPool(NOW, deps);
    expect(result.pool?.items[0]).toMatchObject({
      id: 'contribute:acme/agent#12',
      repo: 'acme/agent',
      stars: 500,
      maintainerEngaged: true,
      labels: ['good first issue'],
    });
  });
});

describe('poolKey', () => {
  it('按北京日期生成 key', () => {
    expect(poolKey('2026-11-18')).toBe('opportunity-pool:v1:2026-11-18');
  });
});
