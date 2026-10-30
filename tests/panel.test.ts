import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 面板端点的关键边界：鉴权、版本失效、设置校验、跟踪动作。
 * 渲染内容只做包含断言，不逐字锁 HTML。
 */

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  updateCalls: [] as Record<string, unknown>[],
  deleteCalls: [] as unknown[],
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
const starsMock = vi.hoisted(() => ({
  loadBindingAuth: vi.fn(
    async (): Promise<
      | { kind: 'ok'; token: string; login: string }
      | { kind: 'unbound' }
      | { kind: 'expired' }
    > => ({ kind: 'ok' as const, token: 'gho_test', login: 'alice-gh' }),
  ),
  favoriteRepo: vi.fn(async () => 'synced' as const),
  unfavoriteRepo: vi.fn(async () => 'removed' as const),
}));
const profileMock = vi.hoisted(() => ({
  readProfile: vi.fn(async () => ({
    facts: ['我主要做 Agent 开发'],
    updatedAt: '2026-10-29T00:00:00.000Z',
  })),
  rememberFact: vi.fn(async () => 'added' as const),
  forgetFacts: vi.fn(async () => ['我主要做 Agent 开发']),
  forgetAll: vi.fn(async () => true),
  PROFILE_MAX_FACTS: 20,
  PROFILE_MAX_FACT_CHARS: 100,
}));
const weeklyMock = vi.hoisted(() => ({
  readWeekStats: vi.fn(async () => ({
    pushed: 6,
    favorited: 3,
    liked: 1,
    disliked: 0,
    more: ['rust', 'agent'],
    less: [] as string[],
  })),
}));
const weatherMock = vi.hoisted(() => ({
  getWeatherForRequest: vi.fn(async () => ({
    condition: 'sun' as const,
    temperature: 26,
    city: '北京',
  })),
}));

vi.mock('../src/config', () => ({
  env: { TOKEN_ENCRYPT_KEY: 'panel-test-key' },
}));

vi.mock('../src/db/client', () => {
  /** 可 await 的 select 流水线：where/orderBy/limit 任意位置 await 都弹队列。 */
  function pipeline() {
    const chain = {
      orderBy: () => chain,
      limit: () => chain,
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve(dbMock.selectQueue.shift() ?? []).then(
          onFulfilled,
          onRejected,
        ),
    };
    return chain;
  }

  return {
    db: () => ({
      select: () => ({ from: () => ({ where: () => pipeline() }) }),
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
      delete: () => ({
        where: async (condition: unknown) => {
          dbMock.deleteCalls.push(condition);
        },
      }),
    }),
  };
});

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

vi.mock('../src/github/stars', () => ({
  loadBindingAuth: starsMock.loadBindingAuth,
  favoriteRepo: starsMock.favoriteRepo,
  unfavoriteRepo: starsMock.unfavoriteRepo,
}));

vi.mock('../src/agent/profile', () => ({
  readProfile: profileMock.readProfile,
  rememberFact: profileMock.rememberFact,
  forgetFacts: profileMock.forgetFacts,
  forgetAll: profileMock.forgetAll,
  PROFILE_MAX_FACTS: profileMock.PROFILE_MAX_FACTS,
  PROFILE_MAX_FACT_CHARS: profileMock.PROFILE_MAX_FACT_CHARS,
}));

vi.mock('../src/agent/weekly-review', () => ({
  readWeekStats: weeklyMock.readWeekStats,
}));

vi.mock('../src/weather/service', () => ({
  getWeatherForRequest: weatherMock.getWeatherForRequest,
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

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectQueue.length = 0;
  dbMock.updateCalls.length = 0;
  dbMock.deleteCalls.length = 0;
  versionMock.version = 1;
});

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
  it('总览渲染订阅状态、快捷入口与注入样式', async () => {
    dbMock.selectQueue.push([
      {
        preferences: { languages: [], keywords: [] },
        active: true,
        createdAt: new Date('2026-10-20T00:00:00Z'),
      },
    ]);
    dbMock.selectQueue.push([]); // archives
    const { state, res } = response();
    await handler({ method: 'GET', query: { t: token(), view: 'overview' } }, res);
    expect(state.status).toBe(200);
    expect(state.body).toContain('每日简报');
    expect(state.body).toContain('推送中');
    expect(state.body).toContain('跟踪仓库');
    // 本周个人卡：真实数字 + 口味，不摆一排 0。
    expect(state.body).toContain('条推送');
    expect(state.body).toContain('个收藏');
    expect(state.body).toContain('订阅天数');
    expect(state.body).toContain('rust');
    // 记忆瓦片用真实条数，不再用 emoji 当数字。
    expect(state.body).not.toContain('🧠');
    // 今日机器人：SVG 软球 + 两颗环绕贴纸（服务端决定图标）。
    expect(state.body).toContain('p-mascot');
    expect(state.body).toContain('/docs/assets/emoji/');
    expect(state.body).toContain('Twemoji');
    // 样式表由 renderPage 的 styles 注入，而不是散落的内联 style。
    expect(state.body).toContain('<style>');
    expect(state.body).toContain('.panel-nav');
    // 面板换成带悬浮阴影的「近白冷调」外壳，而不是整块纯白。
    expect(state.body).toContain('panel-shell');
    expect(state.body).toContain('radial-gradient');
    // 全局 `.panel a` 会盖掉 `.p-btn` 的白字（蓝底蓝字），不能再出现。
    expect(state.body).not.toMatch(/\.panel a\s*\{color:/);
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
    expect(state.body).toContain('name="weatherCity"');
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
    expect(state.body).toContain('跟上了');
    expect(trackingMock.addTrackedRepo).toHaveBeenCalledWith('alice', 'a/b');
  });

  it('暂停推送 → 走 mergePreferences(active:false)', async () => {
    dbMock.selectQueue.push([
      { preferences: { languages: [], keywords: [] }, active: true },
    ]);
    dbMock.selectQueue.push([]); // archives
    const { state, res } = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'overview' },
        body: { action: 'unsubscribe' },
      },
      res,
    );
    expect(state.status).toBe(200);
    expect(prefsMock.mergePreferences).toHaveBeenCalledWith(
      'alice',
      {},
      { active: false },
    );
    expect(state.body).toContain('先安静几天');
  });

  it('未绑定 GitHub 时，收藏页直接给授权按钮（不用回微信）', async () => {
    starsMock.loadBindingAuth.mockResolvedValueOnce({ kind: 'unbound' });
    dbMock.selectQueue.push([]); // renderFavorites 的收藏列表
    const { state, res } = response();
    await handler(
      { method: 'GET', query: { t: token(), view: 'favorites' } },
      res,
    );
    expect(state.status).toBe(200);
    expect(state.body).toContain('绑定 GitHub');
    expect(state.body).toContain('github.com/login/oauth/authorize');
    expect(state.body).toContain('绑定后可以在面板里直接收藏');
  });

  it('收藏动作 → 校验 owner/repo 后调用 favoriteRepo', async () => {
    dbMock.selectQueue.push([]); // renderFavorites 的收藏列表
    const { state, res } = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'favorites' },
        body: { action: 'favorite', fullName: 'vercel/next.js' },
      },
      res,
    );
    expect(starsMock.favoriteRepo).toHaveBeenCalledWith(
      'alice',
      'gho_test',
      'vercel/next.js',
    );
    expect(state.body).toContain('收好了');
    expect(state.body).toContain('vercel/next.js');
  });

  it('收藏动作的非法仓库名 → 不触达 stars 写路径', async () => {
    dbMock.selectQueue.push([]);
    const { state, res } = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'favorites' },
        body: { action: 'favorite', fullName: '../../evil' },
      },
      res,
    );
    expect(starsMock.favoriteRepo).not.toHaveBeenCalled();
    expect(state.body).toContain('仓库名不对');
  });

  it('取消收藏动作 → unfavoriteRepo', async () => {
    dbMock.selectQueue.push([]);
    const { state, res } = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'favorites' },
        body: { action: 'unfavorite', fullName: 'vercel/next.js' },
      },
      res,
    );
    expect(starsMock.unfavoriteRepo).toHaveBeenCalledWith(
      'alice',
      'gho_test',
      'vercel/next.js',
    );
    expect(state.body).toContain('取消了');
    expect(state.body).toContain('vercel/next.js');
  });

  it('记忆页展示并可添加', async () => {
    const { state, res } = response();
    await handler({ method: 'GET', query: { t: token(), view: 'memory' } }, res);
    expect(state.body).toContain('我主要做 Agent 开发');
    expect(state.body).toContain('1/20');

    const added = response();
    await handler(
      {
        method: 'POST',
        query: { t: token(), view: 'memory' },
        body: { action: 'remember', fact: '我在做 Agent' },
      },
      added.res,
    );
    expect(profileMock.rememberFact).toHaveBeenCalledWith('alice', '我在做 Agent');
    expect(added.state.body).toContain('记住了');
  });

  it('设置页有模型入口（一次性 set-key 链接）', async () => {
    dbMock.selectQueue.push([
      { preferences: { languages: [], keywords: [] }, active: true },
    ]);
    const { state, res } = response();
    await handler({ method: 'GET', query: { t: token(), view: 'settings' } }, res);
    expect(state.body).toContain('/api/set-key?t=');
  });
});

describe('命令路由', () => {
  it('「我的面板」路由到 panel', () => {
    expect(decideTextRoute('我的面板')).toEqual({ kind: 'handler', handler: 'panel' });
  });
});
