import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpportunityItem } from '../src/opportunities/types';

const dbMock = vi.hoisted(() => ({
  subscriberRows: [] as Array<Record<string, unknown>>,
  claimRows: [{ key: 'claimed' }] as Array<Record<string, unknown>>,
  claimCalls: [] as unknown[],
  failSelect: false,
}));

vi.mock('../src/db/client', async () => {
  const { subscribers } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (dbMock.failSelect) throw new Error('db down');
            return Promise.resolve(table === subscribers ? [...dbMock.subscriberRows] : []);
          },
        }),
      }),
      insert: (_table: unknown) => ({
        values: (values: unknown) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              dbMock.claimCalls.push(values);
              return dbMock.claimRows;
            },
          }),
        }),
      }),
    }),
  };
});

const poolMock = vi.hoisted(() => ({
  readOpportunityPool: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../src/opportunities/pool', () => ({
  readOpportunityPool: poolMock.readOpportunityPool,
}));

const tasteMock = vi.hoisted(() => ({
  loadUserSignals: vi.fn(async () => ({
    starred: new Set<string>(),
    languageBoost: new Map<string, number>(),
    topicBoost: new Map<string, number>(),
    suppressed: new Set<string>(),
  })),
}));
vi.mock('../src/agent/taste', () => ({
  loadUserSignals: tasteMock.loadUserSignals,
}));

const storeMock = vi.hoisted(() => ({
  readHiddenOpportunities: vi.fn(async () => new Set<string>()),
  markOpportunitiesShown: vi.fn(async () => undefined),
}));
vi.mock('../src/opportunities/store', () => ({
  readHiddenOpportunities: storeMock.readHiddenOpportunities,
  markOpportunitiesShown: storeMock.markOpportunitiesShown,
}));

const apiMock = vi.hoisted(() => ({ sendWeComText: vi.fn() }));
vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

import { pushWeeklyOpportunities } from '../src/agent/weekly-opportunities';

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '...',
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
    score: 80,
    why: '值得修。',
    firstStep: '复现并认领。',
    effort: '小',
    confidence: '高',
    evidence: [],
    ...overrides,
  };
}

const POOL = {
  version: 1,
  date: '2026-11-18',
  dataDate: '2026-11-18',
  generatedAt: '2026-11-18T02:00:00.000Z',
  items: [
    item(),
    item({
      id: 'contribute:acme/two#2',
      repo: 'acme/two',
      issueNumber: 2,
      url: 'https://github.com/acme/two/issues/2',
    }),
    item({
      id: 'research:acme/three#3',
      kind: 'research',
      repo: 'acme/three',
      issueNumber: 3,
      url: 'https://github.com/acme/three/issues/3',
      labels: ['RFC'],
    }),
  ],
};

beforeEach(() => {
  dbMock.subscriberRows = [
    { wecomUserid: 'a', preferences: {} },
    { wecomUserid: 'b', preferences: { weeklyOpportunities: false } },
    { wecomUserid: 'c', preferences: {} },
  ];
  dbMock.claimRows = [{ key: 'claimed' }];
  dbMock.claimCalls = [];
  dbMock.failSelect = false;
  poolMock.readOpportunityPool.mockReset();
  poolMock.readOpportunityPool.mockResolvedValue(POOL as unknown);
  tasteMock.loadUserSignals.mockClear();
  storeMock.readHiddenOpportunities.mockClear();
  storeMock.markOpportunitiesShown.mockClear();
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
});

describe('pushWeeklyOpportunities', () => {
  it('默认开启：给 A/C 各发一次，B 关闭跳过', async () => {
    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));

    expect(result).toEqual({ sent: 2, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    const text = apiMock.sendWeComText.mock.calls[0]![1] as string;
    expect(text).toContain('本周机会');
    expect(text).toContain('[填坑]');
    expect(storeMock.markOpportunitiesShown).toHaveBeenCalledTimes(2);
  });

  it('池为空 → 全部跳过，不发消息', async () => {
    poolMock.readOpportunityPool.mockResolvedValue(null);
    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('claim 已存在 → 跳过', async () => {
    dbMock.claimRows = [];
    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('单个用户发送失败只计 failed，不影响其他用户', async () => {
    apiMock.sendWeComText
      .mockRejectedValueOnce(new Error('wecom down'))
      .mockResolvedValueOnce(undefined);

    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));
    expect(result).toEqual({ sent: 1, skipped: 1, failed: 1 });
  });
});
