import { describe, expect, it, vi } from 'vitest';

/**
 * 面板端点的关键边界：鉴权、版本失效、设置校验、跟踪动作。
 * 渲染内容只做包含断言，不逐字锁 HTML。
 */

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  updateCalls: [] as Record<string, unknown>[],
}));

const versionMock = vi.hoisted(() => ({ version: 1 }));
const trackingMock = vi.hoisted(() => ({
  listTracked: vi.fn(async () => [] as Array<Record<string, unknown>>),
  addTrackedRepo: vi.fn(async () => ({ ok: true, displayName: 'a/b', stars: 1 })),
  removeTracked: vi.fn(async () => undefined),
}));
const prefsMock = vi.hoisted(() => ({
  mergePreferences: vi.fn(async () => undefined),
}));

vi.mock('../src/config', () => ({
  env: { TOKEN_ENCRYPT_KEY: 'panel-test-key' },
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => dbMock.selectQueue.shift() ?? [],
        orderBy: () => ({
          limit: async () => dbMock.selectQueue.shift() ?? [],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbMock.updateCalls.push(values);
        },
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
  }),
}));

vi.mock('../src/panel/version', () => ({
  getPanelVersion: async () => versionMock.version,
  bumpPanelVersion: async () => versionMock.version + 1,
}));

vi.mock('../src/agent/tracking-service', () => ({
  listTracked: trackingMock.listTracked,
  addTrackedRepo: trackingMock.addTrackedRepo,
  removeTracked: trackingMock.removeTracked,
}));

vi.mock('../src/agent/subscription-store', () => ({
  mergePreferences: prefsMock.mergePreferences,
}));

import handler from '../api/panel';
import { signPanelToken } from '../src/panel/token';
import { decideTextRoute } from '../src/wecom/route-decision';

function response() {
  const state: { status: number; body: string; headers: Record<string, string> } = {
    status: 0,
    body: '',
    headers: {},
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    send(body: string) {
      state.body = body;
    },
  };
  return { state, res };
}

function token(): string {
  return signPanelToken('alice', versionMock.version);
}

describe('api/panel 鉴权', () => {
  it('没有 token → 401', async () => {
    const { state, res } = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(state.status).toBe(401);
  });

  it('版本不匹配 → 401（链接已被重置）', async () => {
    versionMock.version = 2;
    const stale = signPanelToken('alice', 1);
    const { state, res } = response();
    await handler({ method: 'GET', query: { t: stale, view: 'overview' } }, res);
    expect(state.status).toBe(401);
    versionMock.version = 1;
  });
});

describe('api/panel 视图', () => {
  it('总览渲染订阅与跟踪入口', async () => {
    dbMock.selectQueue.push([
      { preferences: { languages: [], keywords: [] }, active: true },
    ]);
    dbMock.selectQueue.push([]); // archives
    const { state, res } = response();
    await handler({ method: 'GET', query: { t: token(), view: 'overview' } }, res);
    expect(state.status).toBe(200);
    expect(state.body).toContain('总览');
    expect(state.body).toContain('订阅');
  });

  it('设置越界 → 400 且不写库', async () => {
    dbMock.selectQueue.push([
      { preferences: { languages: [], keywords: [] }, active: true },
    ]);
    const { state, res } = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'settings' },
        body: {
          pushTime: '25:99',
          digestCount: '8',
          intervalDays: '1',
          languages: '',
          keywords: '',
        },
      },
      res,
    );
    expect(state.status).toBe(400);
    expect(state.body).toContain('推送时间');
    expect(prefsMock.mergePreferences).not.toHaveBeenCalled();
  });

  it('跟踪动作成功 → 200 并带确认', async () => {
    const { state, res } = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'tracking' },
        body: { action: 'track', repo: 'a/b' },
      },
      res,
    );
    expect(state.status).toBe(200);
    expect(state.body).toContain('已跟踪');
    expect(trackingMock.addTrackedRepo).toHaveBeenCalledWith('alice', 'a/b');
  });
});

describe('命令路由', () => {
  it('「我的面板」路由到 panel', () => {
    expect(decideTextRoute('我的面板')).toEqual({ kind: 'handler', handler: 'panel' });
  });
});
