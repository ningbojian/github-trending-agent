import { beforeEach, describe, expect, it, vi } from 'vitest';

const digestMock = vi.hoisted(() => ({
  buildDigestForSubscriber: vi.fn(async () => '文本版简报'),
  buildDigestNewsFromSnapshot: vi.fn(async () => ({
    articles: [{ title: 'a' }],
    entries: [{ fullName: 'a/b' }],
  })),
  saveRecentResults: vi.fn(async () => undefined),
}));
vi.mock('../src/agent/digest', () => digestMock);

const snapshotMock = vi.hoisted(() => ({
  getDailySnapshot: vi.fn(
    async (): Promise<{ date: string; items: unknown[] } | null> => ({
      date: '2026-10-30',
      items: [],
    }),
  ),
}));
vi.mock('../src/agent/digest-snapshot', () => ({
  getDailySnapshot: snapshotMock.getDailySnapshot,
}));

const subMock = vi.hoisted(() => ({
  readSubscription: vi.fn(async () => ({ preferences: {} })),
}));
vi.mock('../src/agent/subscription-store', () => ({
  readSubscription: subMock.readSubscription,
}));

const apiMock = vi.hoisted(() => ({
  sendWeComNews: vi.fn(async (_to: string, _articles: unknown) => undefined),
  sendWeComText: vi.fn(async (_to: string, _text: string) => undefined),
}));
vi.mock('../src/wecom/api', () => apiMock);

vi.mock('../src/obs/trace', () => ({ note: () => {} }));

import { handleTodayDigest } from '../src/wecom/today-digest';

const MSG = { fromUserName: 'alice' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  digestMock.buildDigestForSubscriber.mockResolvedValue('文本版简报');
  digestMock.buildDigestNewsFromSnapshot.mockResolvedValue({
    articles: [{ title: 'a' }],
    entries: [{ fullName: 'a/b' }],
  });
  snapshotMock.getDailySnapshot.mockResolvedValue({ date: '2026-10-30', items: [] });
  apiMock.sendWeComNews.mockResolvedValue(undefined);
  apiMock.sendWeComText.mockResolvedValue(undefined);
});

describe('handleTodayDigest', () => {
  it('有快照 → 发 news 卡片，并写 search_caches（收藏 N 才对得上）', async () => {
    await handleTodayDigest(MSG);
    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(digestMock.saveRecentResults).toHaveBeenCalledWith('alice', [
      { fullName: 'a/b' },
    ]);
  });

  it('news 被拒 → 退回纯文本，不静默', async () => {
    apiMock.sendWeComNews.mockRejectedValueOnce(new Error('errcode 40008'));
    await handleTodayDigest(MSG);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', '文本版简报');
  });

  it('没有快照 → 直接发文本', async () => {
    snapshotMock.getDailySnapshot.mockResolvedValueOnce(null);
    await handleTodayDigest(MSG);
    expect(apiMock.sendWeComNews).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', '文本版简报');
  });

  it('当日没有可发条目 → 明确说一声，不发明细', async () => {
    digestMock.buildDigestNewsFromSnapshot.mockResolvedValueOnce({
      articles: [],
      entries: [],
    });
    await handleTodayDigest(MSG);
    expect(apiMock.sendWeComNews).not.toHaveBeenCalled();
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('还没有可发的榜单');
  });
});
