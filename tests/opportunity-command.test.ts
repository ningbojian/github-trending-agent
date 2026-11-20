import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpportunityItem } from '../src/opportunities/types';

const poolMock = vi.hoisted(() => ({
  readLatestOpportunityPool: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../src/opportunities/pool', () => ({
  readLatestOpportunityPool: poolMock.readLatestOpportunityPool,
}));

const subMock = vi.hoisted(() => ({
  readSubscription: vi.fn(async () => ({
    active: true,
    preferences: { languages: ['typescript'], keywords: [], topics: [] },
  })),
}));
vi.mock('../src/agent/subscription-store', () => ({
  readSubscription: subMock.readSubscription,
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
}));
vi.mock('../src/opportunities/store', () => ({
  readHiddenOpportunities: storeMock.readHiddenOpportunities,
}));

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  sendWeComNews: vi.fn(),
}));
vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
  sendWeComNews: apiMock.sendWeComNews,
}));

import {
  formatOpportunityReply,
  handleOpportunities,
} from '../src/wecom/opportunity';

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤...',
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
    score: 80,
    why: '这个坑值得修。',
    firstStep: '按复现步骤跑一遍并认领。',
    effort: '小',
    confidence: '高',
    evidence: [],
    ...overrides,
  };
}

const ITEMS = [
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
    title: 'RFC: 异步 drop 的语义边界',
    url: 'https://github.com/acme/three/issues/3',
    labels: ['RFC'],
  }),
];

function pool(items: OpportunityItem[]) {
  return {
    version: 1,
    date: '2026-11-18',
    dataDate: '2026-11-18',
    generatedAt: '2026-11-18T02:00:00.000Z',
    items,
  };
}

beforeEach(() => {
  poolMock.readLatestOpportunityPool.mockReset();
  poolMock.readLatestOpportunityPool.mockResolvedValue(pool(ITEMS));
  subMock.readSubscription.mockClear();
  tasteMock.loadUserSignals.mockClear();
  storeMock.readHiddenOpportunities.mockReset();
  storeMock.readHiddenOpportunities.mockResolvedValue(new Set());
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  apiMock.sendWeComNews.mockReset();
  apiMock.sendWeComNews.mockResolvedValue(undefined);
});

describe('handleOpportunities', () => {
  it('默认发 3 篇 news 卡片，首篇带仓库 OG 图', async () => {
    await handleOpportunities({
      toUserName: 'corp',
      fromUserName: 'u1',
      createTime: 0,
      msgType: 'text',
      content: '机会',
      msgId: '1',
    });

    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    const articles = apiMock.sendWeComNews.mock.calls[0]![1] as Array<{
      title: string;
      description?: string;
      url: string;
      picurl?: string;
    }>;
    expect(articles).toHaveLength(3);
    expect(articles[0]!.title).toContain('填坑：');
    expect(articles[0]!.title).toContain('修 Windows 检测');
    expect(articles[0]!.description).toContain('acme/agent，issue 12');
    expect(articles[0]!.description).toContain('第一步');
    expect(articles[0]!.picurl).toContain('opengraph');
    expect(articles[1]!.picurl).toBeUndefined();
    expect(articles.map((article) => article.url)).toContain(
      'https://github.com/acme/agent/issues/12',
    );
  });

  it('news 被拒 → 回退到文本卡片', async () => {
    apiMock.sendWeComNews.mockRejectedValueOnce(new Error('news rejected'));

    await handleOpportunities({
      toUserName: 'corp',
      fromUserName: 'u1',
      createTime: 0,
      msgType: 'text',
      content: '机会',
      msgId: '1',
    });

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const text = apiMock.sendWeComText.mock.calls[0]![1] as string;
    expect(text).toContain('填坑：');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1900);
  });

  it('池为空 → 友好提示，不发卡片', async () => {
    poolMock.readLatestOpportunityPool.mockResolvedValue(null);
    await handleOpportunities({
      toUserName: 'corp',
      fromUserName: 'u1',
      createTime: 0,
      msgType: 'text',
      content: '机会',
      msgId: '1',
    });
    const text = apiMock.sendWeComText.mock.calls[0]![1] as string;
    expect(text).toContain('还没准备好');
    expect(apiMock.sendWeComNews).not.toHaveBeenCalled();
  });

  it('hidden 条目被过滤', async () => {
    storeMock.readHiddenOpportunities.mockResolvedValue(
      new Set(['contribute:acme/agent#12']),
    );
    await handleOpportunities({
      toUserName: 'corp',
      fromUserName: 'u1',
      createTime: 0,
      msgType: 'text',
      content: '机会',
      msgId: '1',
    });
    const articles = apiMock.sendWeComNews.mock.calls[0]![1] as Array<{
      url: string;
    }>;
    expect(articles.map((article) => article.url)).not.toContain(
      'https://github.com/acme/agent/issues/12',
    );
  });
});

describe('formatOpportunityReply', () => {
  it('标题、证据、链接都在，且不超字节上限', () => {
    const text = formatOpportunityReply(ITEMS);
    expect(text).toContain('2 填坑 + 1 研究');
    expect(text).toContain('修 Windows 检测');
    expect(text).toContain('第一步：');
    expect(text).toContain('难度：小');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1900);
  });

  it('超长 emoji 标题/文案也绝不超过 1900 字节', () => {
    const huge = item({
      title: '😀'.repeat(400),
      why: '很长的理由'.repeat(200),
      firstStep: '第一步'.repeat(100),
    });
    const text = formatOpportunityReply([huge]);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1900);
  });
});
