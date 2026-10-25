import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResultItem } from '../src/agent/search';

/**
 * env 惰性单例策略：本文件用 vi.mock 固定 src/config（而非设 process.env），
 * 避免 Proxy 缓存跨文件串味。凭据为单元测试专用假值（非真实密钥）。
 */
const ENV = vi.hoisted(() => ({
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key',
}));

vi.mock('../src/config', () => ({ env: ENV }));

// ---------------------------------------------------------------------------
// Mocks：sendWeComText / db 层 / fetch —— 绝不触网、不连库。
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  // mock 工厂必须提供该导出，否则 ESM 绑定期报「No export is defined on the mock」。
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

/**
 * router 现在会在新用户路径调送欢迎礼包（欢迎语 + 首日简报）。
 * 本文件的分发测试只关心「落到哪个 handler」，且多数用例的 select 队列为空
 * （会被判定为新用户）——真实礼包会多打一条 sendWeComText + 尝试跑真实简报查询。
 * 整块替换掉，保持既有断言与输出干净。
 */
vi.mock('../src/wecom/welcome', () => ({
  sendWelcomeFlow: vi.fn().mockResolvedValue(undefined),
  WELCOME_MESSAGE: '欢迎',
}));

const dbMock = vi.hoisted(() => ({
  /** select 队列：每次 await select 链弹出一行数组作为结果集；Error 实例表示该次查询失败。 */
  selectQueue: [] as unknown[],
  selectCalls: [] as { table: unknown; condition: unknown }[],
  orderByCalls: [] as unknown[][],
  insertCalls: [] as {
    table: unknown;
    values: Record<string, unknown>;
    onConflict: unknown;
  }[],
  deleteCalls: [] as { table: unknown; condition: unknown }[],
  events: [] as string[],
}));

vi.mock('../src/db/client', () => {
  /**
   * 可 await 的 select 流水线：orderBy/limit 只记录并返回自身，
   * await 时从队列弹出结果集（模拟 drizzle thenable builder）。
   */
  function selectPipeline() {
    const pipeline = {
      orderBy: (...args: unknown[]) => {
        dbMock.orderByCalls.push(args);
        return pipeline;
      },
      limit: () => pipeline,
      then: (
        onFulfilled?: (value: Record<string, unknown>[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        dbMock.events.push('select');
        const next = dbMock.selectQueue.shift() ?? [];
        if (next instanceof Error) {
          return Promise.reject(next).then(onFulfilled, onRejected);
        }
        return Promise.resolve(next as Record<string, unknown>[]).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return pipeline;
  }

  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            dbMock.selectCalls.push({ table, condition });
            return selectPipeline();
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (onConflict: unknown) => {
            dbMock.events.push('upsert');
            dbMock.insertCalls.push({ table, values, onConflict });
            return Promise.resolve();
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: async (condition: unknown) => {
          dbMock.events.push('delete');
          dbMock.deleteCalls.push({ table, condition });
        },
      }),
    }),
  };
});

import { encryptSecret } from '../src/github/oauth';
import {
  AUTH_EXPIRED_REPLY,
  EMPTY_FAVORITES_REPLY,
  EMPTY_SEARCH_CACHE_REPLY,
  FAVORITE_USAGE_REPLY,
  handleFavorite,
  handleList,
  handleUnfavorite,
  LIST_FAILURE_REPLY,
  NO_SEARCH_CACHE_REPLY,
  STAR_FAILURE_REPLY,
  starRepo,
  UNBOUND_REPLY,
  UNSTAR_FAILURE_REPLY,
  UNFAVORITE_USAGE_REPLY,
  unstarRepo,
} from '../src/github/stars';
import { favorites, searchCaches, subscribers } from '../src/db/schema';
import {
  registerHandlers,
  resetHandlers,
  routeMessage,
  type InboundMessage,
} from '../src/wecom/router';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 按状态码应答的 fetch 桩（绝不触网）。 */
function stubFetchStatus(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** fetch 桩：网络错误 reject。 */
function stubFetchNetworkError(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function compileQuery(wrapper: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(wrapper as SQL);
}

function makeItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    fullName: 'vercel/next.js',
    description: 'The React Framework',
    language: 'TypeScript',
    stars: 128000,
    starsDelta: 321,
    isNew: false,
    date: '2026-10-22',
    htmlUrl: 'https://github.com/vercel/next.js',
    rank: 1,
    ...overrides,
  };
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'gh_agent',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'text',
    content: '收藏 1',
    msgId: '3001',
    ...overrides,
  };
}

/** 已绑定订阅者行（token 为 encryptSecret 加密后的密文）。 */
function boundSubscriberRow(token = 'gho_test_token'): Record<string, unknown> {
  return { githubTokenEnc: encryptSecret(token), githubLogin: 'alice-gh' };
}

/** 入队"最近一次搜索缓存"结果集（handleFavorite 第二次 select）。 */
function seedSearchCache(items: SearchResultItem[]): void {
  dbMock.selectQueue.push([{ results: items }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectQueue.length = 0;
  dbMock.selectCalls.length = 0;
  dbMock.orderByCalls.length = 0;
  dbMock.insertCalls.length = 0;
  dbMock.deleteCalls.length = 0;
  dbMock.events.length = 0;
  apiMock.sendWeComText.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 交互文案常量：字面量逐字固定（防止仅引用常量自证、文案漂移无人察觉）
// ---------------------------------------------------------------------------
describe('交互文案常量（字面量固定）', () => {
  it('四条失败/引导文案与产品文案逐字一致', () => {
    expect(UNBOUND_REPLY).toBe("先发'绑定'授权 GitHub");
    expect(AUTH_EXPIRED_REPLY).toBe("授权已过期，请重新发'绑定'");
    expect(STAR_FAILURE_REPLY).toBe('收藏失败，请稍后再试');
    expect(UNSTAR_FAILURE_REPLY).toBe('取消收藏失败，请稍后再试');
  });

  it('「我的收藏」失败兜底与空态文案逐字固定（发送失败绝不冒充空态）', () => {
    expect(LIST_FAILURE_REPLY).toBe('加载失败，请稍后再试');
    expect(EMPTY_FAVORITES_REPLY).toBe(
      "你还没有收藏任何项目。先搜索一下，再回复'收藏 N'即可收藏并同步 star。",
    );
  });

  it('收藏三态文案与用法提示逐字固定（无缓存/空缓存/越界/序号非法）', () => {
    expect(NO_SEARCH_CACHE_REPLY).toBe(
      '还没有可收藏的结果，先搜索，或等今天的简报（简报里的项目也能收藏）',
    );
    expect(EMPTY_SEARCH_CACHE_REPLY).toBe('最近一次结果为空，请重新搜索');
    expect(FAVORITE_USAGE_REPLY).toBe(
      '用法：「收藏 N」，N 为 1 起的数字，例如：收藏 1',
    );
    expect(UNFAVORITE_USAGE_REPLY).toBe(
      '用法：「取消收藏 N」，N 为 1 起的数字，例如：取消收藏 1',
    );
  });
});

// ---------------------------------------------------------------------------
// starRepo：PUT /user/starred/{owner}/{repo} 三分支
// ---------------------------------------------------------------------------
describe('starRepo（GitHub star，三分支）', () => {
  it('204 → ok：PUT /user/starred/{owner}/{repo}，Bearer token', async () => {
    const fetchMock = stubFetchStatus(204);

    await expect(starRepo('gho_tok', 'vercel/next.js')).resolves.toBe('ok');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/vercel/next.js');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gho_tok');
  });

  it('401 → auth_failed', async () => {
    stubFetchStatus(401);
    await expect(starRepo('bad-token', 'a/b')).resolves.toBe('auth_failed');
  });

  it('其他状态码（500）→ failed，不抛错', async () => {
    stubFetchStatus(500);
    await expect(starRepo('gho_tok', 'a/b')).resolves.toBe('failed');
    expect(console.warn).toHaveBeenCalled();
  });

  it('网络错误 → failed，不抛错（不冲出 handler）', async () => {
    stubFetchNetworkError();
    await expect(starRepo('gho_tok', 'a/b')).resolves.toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// unstarRepo：DELETE /user/starred/{owner}/{repo}
// ---------------------------------------------------------------------------
describe('unstarRepo（GitHub unstar）', () => {
  it('204 → ok：DELETE 同一路径', async () => {
    const fetchMock = stubFetchStatus(204);

    await expect(unstarRepo('gho_tok', 'vercel/next.js')).resolves.toBe('ok');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/vercel/next.js');
    expect(init.method).toBe('DELETE');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gho_tok');
  });

  it('401 → auth_failed', async () => {
    stubFetchStatus(401);
    await expect(unstarRepo('bad', 'a/b')).resolves.toBe('auth_failed');
  });

  it('其他状态码（500）→ failed，不抛错', async () => {
    stubFetchStatus(500);
    await expect(unstarRepo('gho_tok', 'a/b')).resolves.toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// handleFavorite：收藏 N
// ---------------------------------------------------------------------------
describe('handleFavorite（收藏 N → star + 写 favorites）', () => {
  it('未绑定（无订阅者行）→ 回复引导绑定，不写库、不打 GitHub', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([]); // subscribers 无行

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNBOUND_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
    // 第二次 select（search_caches）也不会发生。
    expect(dbMock.selectCalls).toHaveLength(1);
  });

  it('未绑定（行存在但 github_token_enc 为 NULL）→ 同样引导绑定', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([{ githubTokenEnc: null }]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNBOUND_REPLY);
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('SELECT 按调用方 wecom_userid 过滤（per-user isolation，SELECT 与 DELETE 同样按用户隔离）', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()], [{ results: [makeItem()] }]);

    await handleFavorite(makeMsg({ fromUserName: 'bob', content: '收藏 1' }));

    // 第一次 SELECT（subscribers）的条件必须带上调用方的 userid。
    expect(dbMock.selectCalls[0]?.table).toBe(subscribers);
    const compiled = compileQuery(dbMock.selectCalls[0]?.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('bob');

    // 第二次 SELECT（search_caches）同样按调用方隔离。
    const cacheCompiled = compileQuery(dbMock.selectCalls[1]?.condition);
    expect(cacheCompiled.sql).toContain('"search_caches"."wecom_userid"');
    expect(cacheCompiled.params).toContain('bob');
  });

  it('密文损坏（github_token_enc 为垃圾数据）→ 回复授权已过期，不打 GitHub、不写库', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([{ githubTokenEnc: '!!!corrupt-ciphertext!!!' }]);
    seedSearchCache([makeItem()]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(AUTH_EXPIRED_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('成功：解密 token → star 204 → upsert favorites（starred_on_github=true）→ 中文成功回复', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([
      makeItem({ fullName: 'rust-lang/rust' }),
      makeItem({ fullName: 'vercel/next.js' }),
    ]);

    await handleFavorite(makeMsg({ content: '收藏 2' }));

    // GitHub star 打在缓存第 2 条上。
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/vercel/next.js');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);

    // favorites upsert：目标表 + 值 + onConflictDoUpdate（唯一约束幂等）。
    expect(dbMock.insertCalls).toHaveLength(1);
    const upsert = dbMock.insertCalls[0];
    expect(upsert.table).toBe(favorites);
    expect(upsert.values).toMatchObject({
      wecomUserid: 'alice',
      fullName: 'vercel/next.js',
      starredOnGithub: true,
    });
    expect(upsert.onConflict).toBeTruthy();

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('✅ 已收藏 vercel/next.js，已同步到你的 GitHub');
  });

  it('auth_failed（GitHub 401）→ 回复授权已过期，不写 favorites', async () => {
    stubFetchStatus(401);
    dbMock.selectQueue.push([boundSubscriberRow('expired-token')]);
    seedSearchCache([makeItem()]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(AUTH_EXPIRED_REPLY);
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('GitHub 其他失败状态（500）→ 回复通用失败，不写 favorites，不抛错', async () => {
    stubFetchStatus(500);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([makeItem()]);

    await expect(handleFavorite(makeMsg({ content: '收藏 1' }))).resolves.toBeUndefined();

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(STAR_FAILURE_REPLY);
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('N 越界（缓存只有 2 条，收藏 5）→ 回复「最近一次结果只有 2 条，没有第 5 条」，不打 GitHub、不写库', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([makeItem(), makeItem({ fullName: 'a/b' })]);

    await handleFavorite(makeMsg({ content: '收藏 5' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('最近一次结果只有 2 条，没有第 5 条');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('无搜索缓存行 → 回复「还没有可收藏的结果，先搜索，或等今天的简报…」（不再谎报"没有第 1 条"）', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]); // subscribers 有行；cache 队列为空 → 无行

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(NO_SEARCH_CACHE_REPLY);
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('有缓存行但 results 为空 → 回复「最近一次结果为空，请重新搜索」', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(EMPTY_SEARCH_CACHE_REPLY);
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('「收藏一」（中文数字）→ 收藏缓存第 1 条', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([
      makeItem({ fullName: 'rust-lang/rust' }),
      makeItem({ fullName: 'vercel/next.js' }),
    ]);

    await handleFavorite(makeMsg({ content: '收藏一' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/rust-lang/rust');
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('✅ 已收藏 rust-lang/rust，已同步到你的 GitHub');
  });

  it('「收藏 十」（中文数字 10）→ 收藏缓存第 10 条', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache(
      Array.from({ length: 10 }, (_, i) =>
        makeItem({ fullName: `o/r${i + 1}` }),
      ),
    );

    await handleFavorite(makeMsg({ content: '收藏 十' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/o/r10');
  });

  it('「收藏 0」（序号非法）→ 用法提示，不打 GitHub、不写库', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);

    await handleFavorite(makeMsg({ content: '收藏 0' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(FAVORITE_USAGE_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
    // 序号非法在任何读库之前短路（连 subscribers 都不查）。
    expect(dbMock.selectCalls).toHaveLength(0);
  });

  it('简报缓存读取契约：预置简报第 3 条 →「收藏 3」命中该条（简报里的项目也能收藏）', async () => {
    const fetchMock = stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    // 简报推送经 saveRecentResults 写入的正是 { fullName }[] 形态。
    seedSearchCache([
      { fullName: 'a/one' } as SearchResultItem,
      { fullName: 'b/two' } as SearchResultItem,
      { fullName: 'c/three' } as SearchResultItem,
    ]);

    await handleFavorite(makeMsg({ content: '收藏 3' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/c/three');
  });

  it('已收藏幂等：GitHub 无法区分"已 starred"，重复收藏走同一 upsert（唯一约束兜底）', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push(
      [boundSubscriberRow()],
      [{ results: [makeItem()] }],
      [boundSubscriberRow()],
      [{ results: [makeItem()] }],
    );

    await handleFavorite(makeMsg({ content: '收藏 1' }));
    await handleFavorite(makeMsg({ content: '收藏1' }));

    expect(dbMock.insertCalls).toHaveLength(2);
    for (const call of dbMock.insertCalls) {
      expect(call.table).toBe(favorites);
      expect(call.onConflict).toBeTruthy(); // onConflictDoUpdate → 重复收藏不炸唯一约束
    }
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    const [, second] = apiMock.sendWeComText.mock.calls[1] as [string, string];
    expect(second).toBe('✅ 已收藏 vercel/next.js，已同步到你的 GitHub');
  });

  it('「收藏」后跟非数字不进 handler（router 层拦截，直接调用静默返回）', async () => {
    const fetchMock = stubFetchStatus(204);
    await handleFavorite(makeMsg({ content: '收藏夹怎么用' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleUnfavorite：取消收藏 N
// ---------------------------------------------------------------------------
describe('handleUnfavorite（取消收藏 N → unstar + 删行）', () => {
  /** 入队"我的收藏"列表行（handleUnfavorite 第一次 select）。 */
  function seedFavorites(rows: Array<{ fullName: string; createdAt: Date }>): void {
    dbMock.selectQueue.push(rows);
  }

  it('成功：按序号取行 → DELETE unstar 204 → 删 favorites 行 → 回复已取消', async () => {
    const fetchMock = stubFetchStatus(204);
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
      { fullName: 'b/two', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    dbMock.selectQueue.push([boundSubscriberRow()]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 2' }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/b/two');
    expect(init.method).toBe('DELETE');

    expect(dbMock.deleteCalls).toHaveLength(1);
    const del = dbMock.deleteCalls[0];
    expect(del.table).toBe(favorites);
    const compiled = compileQuery(del.condition);
    expect(compiled.sql).toContain('"favorites"."wecom_userid"');
    expect(compiled.sql).toContain('"favorites"."full_name"');
    expect(compiled.params).toContain('alice');
    expect(compiled.params).toContain('b/two');

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 b/two');
  });

  it('「取消收藏二」（中文数字）→ 取消第 2 条收藏', async () => {
    const fetchMock = stubFetchStatus(204);
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
      { fullName: 'b/two', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    dbMock.selectQueue.push([boundSubscriberRow()]);

    await handleUnfavorite(makeMsg({ content: '取消收藏二' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/b/two');
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 b/two');
  });

  it('「取消收藏 0」（序号非法）→ 用法提示，不打 GitHub、不删行', async () => {
    const fetchMock = stubFetchStatus(204);
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 0' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNFAVORITE_USAGE_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('「取消收藏 26」（超出收藏默认上限 25）→ 取消第 26 条（我的收藏可远超 25 条，删除编号不受收藏上限约束）', async () => {
    const fetchMock = stubFetchStatus(204);
    seedFavorites(
      Array.from({ length: 30 }, (_, i) => ({
        fullName: `o/r${i + 1}`,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      })),
    );
    dbMock.selectQueue.push([boundSubscriberRow()]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 26' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/starred/o/r26');
    expect(dbMock.deleteCalls).toHaveLength(1);
    const compiled = compileQuery(dbMock.deleteCalls[0]?.condition);
    expect(compiled.params).toContain('o/r26');
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 o/r26');
  });

  it('「取消收藏 999」（上限内解析成功但列表不足）→ 越界文案「没有第 999 条」', async () => {
    stubFetchStatus(204);
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 999' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('没有第 999 条');
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('「收藏 26」（超过收藏默认上限 25）→ 仍回用法提示（handleFavorite 保持 max=25 不回归）', async () => {
    const fetchMock = stubFetchStatus(204);

    await handleFavorite(makeMsg({ content: '收藏 26' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(FAVORITE_USAGE_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    // 序号非法在任何读库之前短路。
    expect(dbMock.selectCalls).toHaveLength(0);
  });

  it('N 越界（2 条收藏，取消第 3 条）→ 回复「没有第 3 条」，不打 GitHub、不删行', async () => {
    const fetchMock = stubFetchStatus(204);
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
      { fullName: 'b/two', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 3' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('没有第 3 条');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('auth_failed（GitHub 401）→ 回复授权已过期，不删 favorites 行', async () => {
    stubFetchStatus(401);
    seedFavorites([{ fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') }]);
    dbMock.selectQueue.push([boundSubscriberRow('expired')]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(AUTH_EXPIRED_REPLY);
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('GitHub 其他失败状态（500）→ 回复通用失败，不删行，不抛错', async () => {
    stubFetchStatus(500);
    seedFavorites([{ fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') }]);
    dbMock.selectQueue.push([boundSubscriberRow()]);

    await expect(
      handleUnfavorite(makeMsg({ content: '取消收藏 1' })),
    ).resolves.toBeUndefined();

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNSTAR_FAILURE_REPLY);
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('未绑定 → 引导绑定，不打 GitHub、不删行', async () => {
    const fetchMock = stubFetchStatus(204);
    seedFavorites([{ fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') }]);
    dbMock.selectQueue.push([{ githubTokenEnc: null }]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNBOUND_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleList：我的收藏
// ---------------------------------------------------------------------------
describe('handleList（我的收藏 → 编号列表）', () => {
  it('按 created_at 升序列出：编号 + owner/repo + 创建日期', async () => {
    dbMock.selectQueue.push([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T13:00:00Z') },
      { fullName: 'b/two', createdAt: new Date('2026-10-05T08:30:00Z') },
    ]);

    await handleList(makeMsg({ content: '我的收藏' }));

    // 查询按 created_at asc 排序。
    expect(dbMock.orderByCalls).toHaveLength(1);
    const compiled = compileQuery(dbMock.orderByCalls[0][0]);
    expect(compiled.sql).toContain('"favorites"."created_at"');
    expect(compiled.sql).toContain('asc');

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    const lines = content.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('1. a/one（2026-10-01）');
    expect(lines[2]).toBe('2. b/two（2026-10-05）');
  });

  it('空收藏 → 友好中文空态回复（不含编号列表）', async () => {
    dbMock.selectQueue.push([]);

    await handleList(makeMsg({ content: '我的收藏' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(EMPTY_FAVORITES_REPLY);
    expect(content).toContain('收藏');
    expect(content).not.toMatch(/^\d+\./m);
  });

  it('长列表截断：总字节 ≤1800、保留靠前条目、末尾标注「（内容过长，已截断）」', async () => {
    // 40+ 条收藏：每行约 55 字节，整列表远超企微 ~2048 字节文本上限。
    dbMock.selectQueue.push(
      Array.from({ length: 45 }, (_, i) => ({
        fullName: `owner${i}/repo-with-a-fairly-long-name-${i}`,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      })),
    );

    await handleList(makeMsg({ content: '我的收藏' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1800);
    expect(content).toContain('（内容过长，已截断）');
    // 靠前条目保留、靠后条目丢弃（drop-tail）。
    expect(content).toContain('1. owner0/repo-with-a-fairly-long-name-0');
    expect(content).toContain('（2026-10-01）');
    expect(content).not.toContain(
      '45. owner44/repo-with-a-fairly-long-name-44',
    );
  });

  it('非空列表发送失败 → 回「加载失败」兜底，绝不回空态文案（不再谎报"没有收藏"）', async () => {
    dbMock.selectQueue.push([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    // 第一次发送（列表本体）失败，兜底发送成功。
    apiMock.sendWeComText.mockRejectedValueOnce(new Error('wecom down'));

    await expect(
      handleList(makeMsg({ content: '我的收藏' })),
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalled();
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    const contents = apiMock.sendWeComText.mock.calls.map(
      ([, text]) => text as string,
    );
    expect(contents[0]).toContain('1. a/one');
    expect(contents[1]).toBe(LIST_FAILURE_REPLY);
    // 空态文案在任何一次发送中都不得出现。
    expect(contents.every((text) => text !== EMPTY_FAVORITES_REPLY)).toBe(true);
  });

  it('DB 读取失败 → 回「加载失败」，不冒充空态', async () => {
    dbMock.selectQueue.push(new Error('db down'));

    await expect(
      handleList(makeMsg({ content: '我的收藏' })),
    ).resolves.toBeUndefined();

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(LIST_FAILURE_REPLY);
    expect(content).not.toBe(EMPTY_FAVORITES_REPLY);
  });
});

// ---------------------------------------------------------------------------
// router 分发顺序：帮助 → 取消收藏 N → 收藏 N → 我的收藏 → 绑定 → search 兜底
// ---------------------------------------------------------------------------
describe('router 分发顺序（五路由 + search 兜底）', () => {
  const helpHandler = vi.fn();
  const unfavoriteHandler = vi.fn();
  const favoriteHandler = vi.fn();
  const listHandler = vi.fn();
  const bindHandlerMock = vi.fn();
  const searchHandler = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetHandlers();
    registerHandlers({
      help: helpHandler,
      unfavorite: unfavoriteHandler,
      favorite: favoriteHandler,
      list: listHandler,
      bind: bindHandlerMock,
      search: searchHandler,
    });
  });

  it('「帮助」→ help', async () => {
    await routeMessage(makeMsg({ content: '帮助' }));
    expect(helpHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「取消收藏 1」→ unfavorite（不误入 favorite，尽管顺序上收藏在后）', async () => {
    await routeMessage(makeMsg({ content: '取消收藏 1' }));
    expect(unfavoriteHandler).toHaveBeenCalledTimes(1);
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「收藏 1」→ favorite', async () => {
    await routeMessage(makeMsg({ content: '收藏 1' }));
    expect(favoriteHandler).toHaveBeenCalledTimes(1);
    expect(unfavoriteHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「我的收藏」（精确）→ list', async () => {
    await routeMessage(makeMsg({ content: '我的收藏' }));
    expect(listHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「绑定」（精确）→ bind', async () => {
    await routeMessage(makeMsg({ content: '绑定' }));
    expect(bindHandlerMock).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('其他文本 → search 兜底仍然完好', async () => {
    await routeMessage(makeMsg({ content: 'python 热榜' }));
    expect(searchHandler).toHaveBeenCalledTimes(1);
    expect(helpHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(unfavoriteHandler).not.toHaveBeenCalled();
    expect(listHandler).not.toHaveBeenCalled();
    expect(bindHandlerMock).not.toHaveBeenCalled();
  });

  it('「我的收藏夹」（非精确）、「取消收藏」（无数字）→ 回用法提示，不落 search', async () => {
    // 两条老用户行：ensureSubscriber 返回 false，不插欢迎语，只留用法提示。
    dbMock.selectQueue.push([{ wecomUserid: 'alice' }], [{ wecomUserid: 'alice' }]);

    await routeMessage(makeMsg({ content: '我的收藏夹' }));
    await routeMessage(makeMsg({ content: '取消收藏' }));

    expect(searchHandler).not.toHaveBeenCalled();
    expect(listHandler).not.toHaveBeenCalled();
    expect(unfavoriteHandler).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    const contents = apiMock.sendWeComText.mock.calls.map(([, text]) => text);
    expect(contents[0]).toContain('我的收藏');
    expect(contents[1]).toBe(UNFAVORITE_USAGE_REPLY);
  });

  it('端到端：「收藏 1。」经真实 handleFavorite 也成功（router 归一化尾标点后 handler 不再静默）', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([{ wecomUserid: 'alice' }]); // ensureSubscriber：老用户
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([makeItem({ fullName: 'a/one' })]);
    resetHandlers();
    registerHandlers({ favorite: handleFavorite });

    await routeMessage(makeMsg({ content: '收藏 1。' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('✅ 已收藏 a/one，已同步到你的 GitHub');
  });

  it('端到端：「取消收藏一。」经真实 handleUnfavorite 也成功', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([{ wecomUserid: 'alice' }]); // ensureSubscriber：老用户
    dbMock.selectQueue.push([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    resetHandlers();
    registerHandlers({ unfavorite: handleUnfavorite });

    await routeMessage(makeMsg({ content: '取消收藏一。' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 a/one');
  });
});

// ---------------------------------------------------------------------------
// 出站兜底日志：所有吞错路径必须留运维可见的痕迹（零日志盲区补齐）。
// ---------------------------------------------------------------------------
describe('出站兜底日志（零日志盲区补齐）', () => {
  /** 入队"我的收藏"列表行（handleList / handleUnfavorite 的第一次 select）。 */
  function seedFavorites(
    rows: Array<{ fullName: string; createdAt: Date }>,
  ): void {
    dbMock.selectQueue.push(rows);
  }

  it('favorite：确认发送失败且兜底也失败 → 记两条日志，不重试不重入', async () => {
    stubFetchStatus(204);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([makeItem()]);
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    await expect(
      handleFavorite(makeMsg({ content: '收藏 1' })),
    ).resolves.toBeUndefined();

    // 确认 + 兜底各发一次，无重试。
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      'favorite fallback reply failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
  });

  it('unfavorite：确认发送失败且兜底也失败 → 记两条日志', async () => {
    stubFetchStatus(204);
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    await expect(
      handleUnfavorite(makeMsg({ content: '取消收藏 1' })),
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      'unfavorite fallback reply failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
  });

  it('list：首条发送失败且兜底也失败 → 记两条日志', async () => {
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    await expect(
      handleList(makeMsg({ content: '我的收藏' })),
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      'handleList failed:',
      expect.any(Error),
    );
    expect(console.error).toHaveBeenCalledWith(
      'list fallback reply failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
  });

  it('favorite：tokenEnc 解密失败 → AUTH_EXPIRED + console.warn 解密日志', async () => {
    dbMock.selectQueue.push([
      { githubTokenEnc: 'garbage-not-encrypted', githubLogin: 'alice-gh' },
    ]);
    seedSearchCache([makeItem()]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      AUTH_EXPIRED_REPLY,
    );
    expect(console.warn).toHaveBeenCalledWith(
      'favorite token decrypt failed:',
      expect.any(Error),
    );
  });

  it('unfavorite：tokenEnc 解密失败 → AUTH_EXPIRED + console.warn 解密日志', async () => {
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    dbMock.selectQueue.push([
      { githubTokenEnc: 'garbage-not-encrypted', githubLogin: 'alice-gh' },
    ]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      AUTH_EXPIRED_REPLY,
    );
    expect(console.warn).toHaveBeenCalledWith(
      'unfavorite token decrypt failed:',
      expect.any(Error),
    );
  });
});
