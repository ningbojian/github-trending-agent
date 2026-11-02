import { beforeEach, describe, expect, it, vi } from 'vitest';

const digestMock = vi.hoisted(() => ({
  pushDigests: vi.fn(async (_now?: Date, _options?: unknown) => ({
    sent: 1,
    skipped: 0,
    failed: 0,
  })),
}));
vi.mock('../src/agent/digest', () => ({
  PUSH_BUDGET_MS: 240_000,
  pushDigests: digestMock.pushDigests,
}));

const dbMock = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  fail: false,
}));
vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (dbMock.fail) throw new Error('db down');
            return [...dbMock.rows];
          },
        }),
      }),
    }),
  }),
}));

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(async (_to: string, _text: string) => undefined),
  sendWeComNews: vi.fn(async () => undefined),
}));
vi.mock('../src/wecom/api', () => apiMock);
vi.mock('../src/obs/trace', () => ({ note: () => {} }));

import { handleTodayDigest } from '../src/wecom/today-digest';

const MSG = { fromUserName: 'alice' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.rows = [];
  dbMock.fail = false;
  digestMock.pushDigests.mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
});

describe('handleTodayDigest', () => {
  it('没订阅 → 提示先订阅，不触发推送', async () => {
    await handleTodayDigest(MSG);
    expect(digestMock.pushDigests).not.toHaveBeenCalled();
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('先发「订阅」');
  });

  it('已退订 → 提示恢复方式', async () => {
    dbMock.rows = [{ preferences: {}, active: false, lastDigestAt: null }];
    await handleTodayDigest(MSG);
    expect(digestMock.pushDigests).not.toHaveBeenCalled();
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('退订状态');
  });

  it('今天已经发过 → 告知时间，不再重复发', async () => {
    dbMock.rows = [
      {
        preferences: { pushTime: '10:00' },
        active: true,
        lastDigestAt: new Date('2026-11-02T02:15:00.000Z'), // 北京 10:15
      },
    ];
    await handleTodayDigest(MSG);
    expect(digestMock.pushDigests).not.toHaveBeenCalled();
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('10:15');
  });

  it('未发过 → 走 pushDigests，忽略推送时间但不绕过去重', async () => {
    dbMock.rows = [
      {
        preferences: { pushTime: '10:00' },
        active: true,
        lastDigestAt: new Date('2026-11-01T02:15:00.000Z'),
      },
    ];
    await handleTodayDigest(MSG);
    expect(digestMock.pushDigests).toHaveBeenCalledWith(
      expect.any(Date),
      expect.objectContaining({ onlyUserId: 'alice', ignorePushTime: true }),
    );
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('没有可发条目 → 明确说一声', async () => {
    dbMock.rows = [{ preferences: {}, active: true, lastDigestAt: null }];
    digestMock.pushDigests.mockResolvedValue({ sent: 0, skipped: 1, failed: 0 });
    await handleTodayDigest(MSG);
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('没有可发的新项目');
  });

  it('查询异常 → 兜底文本，不抛错', async () => {
    dbMock.fail = true;
    await handleTodayDigest(MSG);
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('暂时取不到');
  });
});
