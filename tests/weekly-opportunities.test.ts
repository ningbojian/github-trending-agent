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
  readLatestOpportunityPool: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../src/opportunities/pool', () => ({
  readLatestOpportunityPool: poolMock.readLatestOpportunityPool,
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
  readShownOpportunities: vi.fn(async () => new Set<string>()),
  markOpportunitiesShown: vi.fn(async () => undefined),
}));
vi.mock('../src/opportunities/store', () => ({
  readHiddenOpportunities: storeMock.readHiddenOpportunities,
  readShownOpportunities: storeMock.readShownOpportunities,
  markOpportunitiesShown: storeMock.markOpportunitiesShown,
}));

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  sendWeComNews: vi.fn(),
}));
vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
  sendWeComNews: apiMock.sendWeComNews,
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
    short: '修 Windows 检测',
    repoDescription: 'agent toolkit',
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
  poolMock.readLatestOpportunityPool.mockReset();
  poolMock.readLatestOpportunityPool.mockResolvedValue(POOL as unknown);
  tasteMock.loadUserSignals.mockClear();
  storeMock.readHiddenOpportunities.mockClear();
  storeMock.readShownOpportunities.mockReset();
  storeMock.readShownOpportunities.mockResolvedValue(new Set());
  storeMock.markOpportunitiesShown.mockClear();
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  apiMock.sendWeComNews.mockReset();
  apiMock.sendWeComNews.mockResolvedValue(undefined);
});

describe('pushWeeklyOpportunities', () => {
  it('默认开启：给 A/C 各发一次 news 卡片，B 关闭跳过', async () => {
    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));

    expect(result).toEqual({ sent: 2, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(2);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    const articles = apiMock.sendWeComNews.mock.calls[0]![1] as Array<{
      title: string;
      description?: string;
      url: string;
      picurl?: string;
    }>;
    expect(articles).toHaveLength(3);
    expect(articles[0]!.title).not.toContain('填坑');
    expect(articles[0]!.title.startsWith('agent toolkit｜')).toBe(true);
    expect(articles[0]!.title).toContain('修 Windows 检测');
    expect(articles[0]!.description).toContain('acme/agent，issue 12');
    expect(articles[0]!.description).toContain('修 Windows 检测');
    expect(articles[0]!.description).not.toContain('第一步');
    expect(articles[0]!.picurl).toContain('opengraph');
    expect(articles[1]!.picurl).toBeUndefined();
    expect(storeMock.markOpportunitiesShown).toHaveBeenCalledTimes(2);
  });

  it('池为空 → 全部跳过，不发消息', async () => {
    poolMock.readLatestOpportunityPool.mockResolvedValue(null);
    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComNews).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('claim 已存在 → 跳过', async () => {
    dbMock.claimRows = [];
    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('news 失败回退文本仍计 sent', async () => {
    apiMock.sendWeComNews.mockRejectedValueOnce(new Error('news down'));

    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));

    expect(result).toEqual({ sent: 2, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText.mock.calls[0]![1] as string).toContain(
      '本周机会',
    );
  });

  it('news 与文本都失败只计 failed，不影响其他用户', async () => {
    apiMock.sendWeComNews
      .mockRejectedValueOnce(new Error('news down'))
      .mockResolvedValueOnce(undefined);
    apiMock.sendWeComText.mockRejectedValueOnce(new Error('wecom down'));

    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));
    expect(result).toEqual({ sent: 1, skipped: 1, failed: 1 });
  });

  it('已展示过的条目不再进本周推送', async () => {
    storeMock.readShownOpportunities.mockResolvedValue(
      new Set(['contribute:acme/agent#12']),
    );

    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));

    expect(result.sent).toBe(2);
    const articles = apiMock.sendWeComNews.mock.calls[0]![1] as Array<{
      url: string;
    }>;
    const urls = articles.map((article) => article.url);
    expect(urls).not.toContain('https://github.com/acme/agent/issues/12');
    expect(urls).toContain('https://github.com/acme/two/issues/2');
  });

  it('超过 50 个订阅者也不丢人', async () => {
    dbMock.subscriberRows = Array.from({ length: 60 }, (_, index) => ({
      wecomUserid: `u${index}`,
      preferences: {},
    }));

    const result = await pushWeeklyOpportunities(new Date('2026-11-18T02:00:00.000Z'));

    expect(result.sent).toBe(60);
    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(60);
  });
});
