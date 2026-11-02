import { beforeEach, describe, expect, it, vi } from 'vitest';

const digestMock = vi.hoisted(() => ({
  buildExtraDigest: vi.fn(),
  saveRecentResults: vi.fn(async () => undefined),
}));
vi.mock('../src/agent/digest', () => ({
  buildExtraDigest: digestMock.buildExtraDigest,
  saveRecentResults: digestMock.saveRecentResults,
}));

const batchMock = vi.hoisted(() => ({
  readBatch: vi.fn(async () => ({ batches: 0, shown: [] })),
  recordBatch: vi.fn(async () => ({ batches: 1, shown: [] })),
}));
vi.mock('../src/agent/digest-batch', () => ({
  MAX_EXTRA_BATCHES: 3,
  readBatch: batchMock.readBatch,
  recordBatch: batchMock.recordBatch,
}));

const historyMock = vi.hoisted(() => ({ recordPush: vi.fn(async () => undefined) }));
vi.mock('../src/agent/push-history', () => ({
  recordPush: historyMock.recordPush,
}));

const apiMock = vi.hoisted(() => ({
  sendWeComNews: vi.fn(async (_to: string, _articles: unknown) => undefined),
  sendWeComText: vi.fn(async (_to: string, _text: string) => undefined),
}));
vi.mock('../src/wecom/api', () => apiMock);
vi.mock('../src/obs/trace', () => ({ note: () => {} }));

import { handleMoreDigest } from '../src/wecom/more-digest';

const MSG = { fromUserName: 'alice' } as never;

const ARTICLES = [
  { title: '1. a/b ★100 (+50)', url: 'https://github.com/a/b' },
  { title: '2. c/d ★200 (+80)', url: 'https://github.com/c/d' },
];

function extra(remaining = 5) {
  return {
    articles: ARTICLES,
    entries: [{ fullName: 'a/b' }, { fullName: 'c/d' }],
    remaining,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  batchMock.readBatch.mockResolvedValue({ batches: 0, shown: [] });
  batchMock.recordBatch.mockResolvedValue({ batches: 1, shown: [] });
  digestMock.buildExtraDigest.mockResolvedValue(extra());
  apiMock.sendWeComNews.mockResolvedValue(undefined);
  apiMock.sendWeComText.mockResolvedValue(undefined);
});

describe('handleMoreDigest', () => {
  it('今天已经 3 批 → 直接说看完了，不再构建', async () => {
    batchMock.readBatch.mockResolvedValue({ batches: 3, shown: [] });
    await handleMoreDigest(MSG);
    expect(digestMock.buildExtraDigest).not.toHaveBeenCalled();
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('看完了');
  });

  it('没有更多候选 → 说看完了', async () => {
    digestMock.buildExtraDigest.mockResolvedValue({ articles: [], entries: [], remaining: 0 });
    await handleMoreDigest(MSG);
    expect(apiMock.sendWeComNews).not.toHaveBeenCalled();
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('看完了');
  });

  it('成功 → 发卡片、写缓存/历史/游标，并提示剩余', async () => {
    await handleMoreDigest(MSG);

    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(1);
    expect(digestMock.saveRecentResults).toHaveBeenCalledWith('alice', [
      { fullName: 'a/b' },
      { fullName: 'c/d' },
    ]);
    expect(historyMock.recordPush).toHaveBeenCalledWith('alice', ['a/b', 'c/d']);
    expect(batchMock.recordBatch).toHaveBeenCalledWith('alice', ['a/b', 'c/d']);
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('还有 5 个候选');
  });

  it('卡片被拒 → 退回文本（带序号与链接）', async () => {
    apiMock.sendWeComNews.mockRejectedValueOnce(new Error('errcode'));
    await handleMoreDigest(MSG);
    const text = String(apiMock.sendWeComText.mock.calls[0]?.[1]);
    expect(text).toContain('今天的下一批');
    expect(text).toContain('https://github.com/a/b');
  });

  it('没有订阅者 → 提示先订阅', async () => {
    digestMock.buildExtraDigest.mockResolvedValue(null);
    await handleMoreDigest(MSG);
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('先发「订阅」');
  });
});
