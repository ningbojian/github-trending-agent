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

const apiMock = vi.hoisted(() => ({ sendWeComText: vi.fn() }));
vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
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
});

describe('handleOpportunities', () => {
  it('回复 2 填坑 + 1 研究，控制在 1900 字节内', async () => {
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
    expect(text).toContain('[填坑]');
    expect(text).toContain('[研究]');
    expect(text).toContain('https://github.com/acme/agent/issues/12');
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
    const text = apiMock.sendWeComText.mock.calls[0]![1] as string;
    expect(text).not.toContain('https://github.com/acme/agent/issues/12');
  });
});

describe('formatOpportunityReply', () => {
  it('标题、证据、链接都在，且不超字节上限', () => {
    const text = formatOpportunityReply(ITEMS);
    expect(text).toContain('2 填坑 + 1 研究');
    expect(text).toContain('为什么：');
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
