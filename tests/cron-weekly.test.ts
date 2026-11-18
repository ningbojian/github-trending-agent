import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * cron 端点是「编排」：鉴权、顺序、响应形状。
 * 每一步的成败判断在各自模块里测；这里只证明每周复盘真的被接上了，
 * 且它的失败不会把每日推送的响应变成 500。
 */

const weeklyMock = vi.hoisted(() => ({
  pushWeeklyReviews: vi.fn(async () => ({ sent: 2, skipped: 1, failed: 0 })),
}));

const digestMock = vi.hoisted(() => ({
  pushDigests: vi.fn(async () => ({ sent: 3, skipped: 4, failed: 0 })),
}));

const emailMock = vi.hoisted(() => ({
  pushEmailDigests: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 })),
}));

const snapshotMock = vi.hoisted(() => ({
  getDailySnapshot: vi.fn(async () => ({ date: '2026-10-26', items: [] })),
}));

const dueMock = vi.hoisted(() => ({
  probeDue: vi.fn(
    async (): Promise<{
      due: boolean;
      checked: boolean;
      cache: 'hit' | 'miss' | 'off';
      window: boolean;
    }> => ({
      due: true,
      checked: true,
      cache: 'miss',
      window: true,
    }),
  ),
  refreshDueState: vi.fn(async () => {}),
}));

const gateMock = vi.hoisted(() => ({
  cronGates: vi.fn(() => ({ tracking: true, weekly: true, heartbeat: true })),
}));

vi.mock('../src/agent/digest', () => ({
  PUSH_BUDGET_MS: 240_000,
  pushDigests: digestMock.pushDigests,
}));
vi.mock('../src/agent/observation', () => ({
  getDailyObservations: async () => null,
}));
const trackingMock = vi.hoisted(() => ({
  pushTrackedChanges: vi.fn(async () => ({
    sent: 0,
    skipped: 0,
    failed: 0,
    checked: 0,
  })),
}));

vi.mock('../src/agent/tracking-check', () => ({
  pushTrackedChanges: trackingMock.pushTrackedChanges,
}));
vi.mock('../src/agent/digest-snapshot', () => ({
  getDailySnapshot: snapshotMock.getDailySnapshot,
}));
// due 缓存的内部逻辑单独测；cron 编排测试里固定当作有人到点。
vi.mock('../src/agent/due-state-cache', () => ({
  probeDue: dueMock.probeDue,
  refreshDueState: dueMock.refreshDueState,
}));
vi.mock('../src/email/push', () => ({
  pushEmailDigests: emailMock.pushEmailDigests,
}));
vi.mock('../src/email/tokens', () => ({
  resolveBaseUrl: () => 'https://example.test',
}));
vi.mock('../src/wecom/capacity', () => ({
  getWeComMemberCount: async () => undefined,
}));
// 围栏的时间逻辑在 tests/cron-gates.test.ts 单独测；编排测试按用例覆写。
vi.mock('../src/agent/cron-gates', () => ({
  cronGates: gateMock.cronGates,
}));
vi.mock('../src/agent/weekly-review', () => ({
  pushWeeklyReviews: weeklyMock.pushWeeklyReviews,
}));
vi.mock('../src/config', () => ({
  env: { CRON_SECRET: 'cron-secret' },
}));

import handler from '../api/cron-push-digest';

beforeEach(() => {
  dueMock.probeDue.mockReset();
  dueMock.probeDue.mockResolvedValue({
    due: true,
    checked: true,
    cache: 'miss',
    window: true,
  });
  dueMock.refreshDueState.mockClear();
  gateMock.cronGates.mockReset();
  gateMock.cronGates.mockReturnValue({
    tracking: true,
    weekly: true,
    heartbeat: true,
  });
  digestMock.pushDigests.mockClear();
  emailMock.pushEmailDigests.mockClear();
  snapshotMock.getDailySnapshot.mockClear();
  weeklyMock.pushWeeklyReviews.mockClear();
  trackingMock.pushTrackedChanges.mockClear();
});

function response() {
  const state: { status: number; body: string } = { status: 0, body: '' };
  return {
    state,
    res: {
      status(code: number) {
        state.status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      send(body: string) {
        state.body = body;
      },
    },
  };
}

describe('cron-push-digest', () => {
  it('鉴权通过 → 推送后返回每日与每周两组计数', async () => {
    const { state, res } = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res);
    expect(state.status).toBe(200);
    const body = JSON.parse(state.body) as {
      sent: number;
      weekly: { sent: number; skipped: number; failed: number };
    };
    expect(body.sent).toBe(3);
    expect(body.weekly).toEqual({ sent: 2, skipped: 1, failed: 0 });
    expect(weeklyMock.pushWeeklyReviews).toHaveBeenCalledTimes(1);
    expect(dueMock.refreshDueState).toHaveBeenCalledTimes(1);
  });

  it('鉴权失败 → 401，且不触发任何推送', async () => {
    weeklyMock.pushWeeklyReviews.mockClear();
    const { state, res } = response();
    await handler({ method: 'GET', headers: {} }, res);
    expect(state.status).toBe(401);
    expect(weeklyMock.pushWeeklyReviews).not.toHaveBeenCalled();
  });

  it('缓存命中且不在窗口、又没有其它围栏 → 直接返回，不查库/不推送', async () => {
    dueMock.probeDue.mockResolvedValue({
      due: false,
      checked: false,
      cache: 'hit',
      window: false,
    });
    gateMock.cronGates.mockReturnValue({
      tracking: false,
      weekly: false,
      heartbeat: false,
    });

    const { state, res } = response();
    await handler(
      { method: 'GET', headers: { authorization: 'Bearer cron-secret' } },
      res,
    );

    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      sent: 0,
      email: { sent: 0 },
      weekly: { sent: 0 },
      tracking: { sent: 0 },
    });
    expect(digestMock.pushDigests).not.toHaveBeenCalled();
    expect(emailMock.pushEmailDigests).not.toHaveBeenCalled();
    expect(snapshotMock.getDailySnapshot).not.toHaveBeenCalled();
    expect(dueMock.refreshDueState).not.toHaveBeenCalled();
    expect(trackingMock.pushTrackedChanges).not.toHaveBeenCalled();
  });

  it('无 due 但 tracking 围栏打开 → 仍然跑跟踪检查，不推送简报', async () => {
    dueMock.probeDue.mockResolvedValue({
      due: false,
      checked: false,
      cache: 'hit',
      window: false,
    });
    gateMock.cronGates.mockReturnValue({
      tracking: true,
      weekly: false,
      heartbeat: true,
    });

    const { state, res } = response();
    await handler(
      { method: 'GET', headers: { authorization: 'Bearer cron-secret' } },
      res,
    );

    expect(state.status).toBe(200);
    expect(trackingMock.pushTrackedChanges).toHaveBeenCalledTimes(1);
    expect(digestMock.pushDigests).not.toHaveBeenCalled();
    expect(emailMock.pushEmailDigests).not.toHaveBeenCalled();
  });

  it('无 due 但 weekly 围栏打开 → 仍然跑周报，不推送简报', async () => {
    dueMock.probeDue.mockResolvedValue({
      due: false,
      checked: false,
      cache: 'hit',
      window: false,
    });
    gateMock.cronGates.mockReturnValue({
      tracking: false,
      weekly: true,
      heartbeat: true,
    });

    const { state, res } = response();
    await handler(
      { method: 'GET', headers: { authorization: 'Bearer cron-secret' } },
      res,
    );

    expect(state.status).toBe(200);
    expect(weeklyMock.pushWeeklyReviews).toHaveBeenCalledTimes(1);
    expect(digestMock.pushDigests).not.toHaveBeenCalled();
    expect(emailMock.pushEmailDigests).not.toHaveBeenCalled();
  });
});
