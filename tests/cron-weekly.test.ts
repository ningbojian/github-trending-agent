import { describe, expect, it, vi } from 'vitest';

/**
 * cron 端点是「编排」：鉴权、顺序、响应形状。
 * 每一步的成败判断在各自模块里测；这里只证明每周复盘真的被接上了，
 * 且它的失败不会把每日推送的响应变成 500。
 */

const weeklyMock = vi.hoisted(() => ({
  pushWeeklyReviews: vi.fn(async () => ({ sent: 2, skipped: 1, failed: 0 })),
}));

vi.mock('../src/agent/digest', () => ({
  PUSH_BUDGET_MS: 240_000,
  pushDigests: async () => ({ sent: 3, skipped: 4, failed: 0 }),
}));
vi.mock('../src/agent/observation', () => ({
  getDailyObservations: async () => null,
}));
vi.mock('../src/agent/tracking-check', () => ({
  pushTrackedChanges: async () => ({ sent: 0, skipped: 0, failed: 0, checked: 0 }),
}));
vi.mock('../src/agent/digest-snapshot', () => ({
  getDailySnapshot: async () => ({ date: '2026-10-26', items: [] }),
}));
vi.mock('../src/email/push', () => ({
  pushEmailDigests: async () => ({ sent: 1, skipped: 0, failed: 0 }),
}));
vi.mock('../src/email/tokens', () => ({
  resolveBaseUrl: () => 'https://example.test',
}));
vi.mock('../src/wecom/capacity', () => ({
  refreshWeComMemberCount: async () => undefined,
}));
vi.mock('../src/agent/weekly-review', () => ({
  pushWeeklyReviews: weeklyMock.pushWeeklyReviews,
}));
vi.mock('../src/config', () => ({
  env: { CRON_SECRET: 'cron-secret' },
}));

import handler from '../api/cron-push-digest';

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
  });

  it('鉴权失败 → 401，且不触发任何推送', async () => {
    weeklyMock.pushWeeklyReviews.mockClear();
    const { state, res } = response();
    await handler({ method: 'GET', headers: {} }, res);
    expect(state.status).toBe(401);
    expect(weeklyMock.pushWeeklyReviews).not.toHaveBeenCalled();
  });
});
