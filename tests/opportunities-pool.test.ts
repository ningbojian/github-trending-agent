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
});

describe('buildOpportunityPool', () => {
  const deps = {
    claim: async () => true,
    release: async () => {},
  };

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
