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

// 多轮待办在 router 里是一次额外查询；本文件只测分发与收藏链路，
// 默认「没有待办」，不占用 select 队列（见 pending.test.ts / router.test.ts）。
vi.mock('../src/agent/pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/pending')>();
  return {
    ...actual,
    readPending: async () => null,
    clearPending: async () => undefined,
  };
});

vi.mock('../src/wecom/pending', () => ({
  handlePendingReply: async () => undefined,
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
  formatGithubStarsList,
  handleFavorite,
  handleList,
  handleUnfavorite,
  LIST_FAILURE_REPLY,
  loadGithubStars,
  NO_SEARCH_CACHE_REPLY,
  STAR_FAILURE_REPLY,
  STAR_SYNC_FAILED_REPLY,
  STARS_FALLBACK_NOTE,
  starRepo,
  UNBOUND_REPLY,
  UNBOUND_STARS_NOTE,
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

/**
 * GitHub star 列表桩：
 * - `per_page=10` → 条目 JSON（full_name）
 * - `per_page=1`  → 空数组 + `Link: rel="last"` 表达总数（total 为 null 表示不带 Link）
 * - DELETE（取消 star）→ 204
 */
function stubGithubStars(
  fullNames: string[],
  total: number | null = fullNames.length,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    const target = String(url);
    if (/[?&]per_page=1(?:&|$)/.test(target)) {
      const headers: Record<string, string> = {};
      if (total !== null) {
        headers.link = `<${target.split('?')[0]}?per_page=1&page=${total}>; rel="last"`;
      }
      return new Response('[]', { status: 200, headers });
    }
    return new Response(
      JSON.stringify(fullNames.map((full_name) => ({ full_name }))),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 按状态码应答、带 headers.json() 的星级接口桩（401/429/500 等错误分支）。 */
function stubStarsStatus(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response('[]', { status }));
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
    expect(STAR_SYNC_FAILED_REPLY).toBe(
      '⚠️ 已记下，但同步 GitHub 失败（不影响以后不再推它）；稍后可再发「收藏 N」重试。',
    );
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

  it('成功：先落 starred_on_github=false → star 204 → 改 true → 中文成功回复', async () => {
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

    // favorites upsert 两次：先 false（网络再怎么抖，这条也已经记下），成功后改 true。
    expect(dbMock.insertCalls).toHaveLength(2);
    expect(dbMock.events).toEqual(['select', 'select', 'upsert', 'upsert']);
    const first = dbMock.insertCalls[0];
    expect(first?.table).toBe(favorites);
    expect(first?.values).toMatchObject({
      wecomUserid: 'alice',
      fullName: 'vercel/next.js',
      starredOnGithub: false,
    });
    const upsert = dbMock.insertCalls[1];
    expect(upsert?.values).toMatchObject({ starredOnGithub: true });
    expect(upsert?.onConflict).toBeTruthy();

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('✅ 已收藏 vercel/next.js，已同步到你的 GitHub');
  });

  it('冲突时 starred_on_github 取「或」：同步成功过就不会被后来的失败降级', async () => {
    stubFetchStatus(500);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([makeItem()]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    const upsert = dbMock.insertCalls[0];
    const set = (upsert?.onConflict as { set: { starredOnGithub: unknown } }).set;
    const compiled = compileQuery(set.starredOnGithub);
    expect(compiled.sql.toLowerCase()).toContain(' or ');
    expect(compiled.params).toContain(false);
  });

  it('auth_failed（GitHub 401）→ 本地仍记下（以后不再推它），回复授权已过期', async () => {
    stubFetchStatus(401);
    dbMock.selectQueue.push([boundSubscriberRow('expired-token')]);
    seedSearchCache([makeItem()]);

    await handleFavorite(makeMsg({ content: '收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(AUTH_EXPIRED_REPLY);
    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.values).toMatchObject({ starredOnGithub: false });
  });

  it('GitHub 其他失败状态（500）→ 记下本地收藏并说明同步失败，不抛错', async () => {
    stubFetchStatus(500);
    dbMock.selectQueue.push([boundSubscriberRow()]);
    seedSearchCache([makeItem()]);

    await expect(handleFavorite(makeMsg({ content: '收藏 1' }))).resolves.toBeUndefined();

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(STAR_SYNC_FAILED_REPLY);
    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.values).toMatchObject({
      wecomUserid: 'alice',
      fullName: 'vercel/next.js',
      starredOnGithub: false,
    });
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

    // 每次收藏两次 upsert（先 false 再 true），四次全部命中唯一约束。
    expect(dbMock.insertCalls).toHaveLength(4);
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
  /** 订阅者行入队（handleUnfavorite 第一次 select）。 */
  function seedBinding(row: Record<string, unknown>): void {
    dbMock.selectQueue.push([row]);
  }

  /** 本地 favorites 行入队（仅在未绑定 / GitHub 拉取失败时才会被读到）。 */
  function seedFavorites(rows: Array<{ fullName: string; createdAt: Date }>): void {
    dbMock.selectQueue.push(rows);
  }

  /** 取出 DELETE（取消 star）那一次调用，跳过列表请求。 */
  function deleteCall(
    fetchMock: ReturnType<typeof vi.fn>,
  ): [string, RequestInit] | undefined {
    return (fetchMock.mock.calls as [string, RequestInit][]).find(
      ([, init]) => init?.method === 'DELETE',
    );
  }

  it('已绑定：按 GitHub 列表（star 时间倒序）的序号 → DELETE unstar 204 → 删 favorites 行 → 回复已取消', async () => {
    const fetchMock = stubGithubStars(['newest/one', 'older/two'], 2);
    seedBinding(boundSubscriberRow());

    await handleUnfavorite(makeMsg({ content: '取消收藏 2' }));

    const call = deleteCall(fetchMock);
    expect(call?.[0]).toBe('https://api.github.com/user/starred/older/two');
    expect(call?.[1].method).toBe('DELETE');

    expect(dbMock.deleteCalls).toHaveLength(1);
    const del = dbMock.deleteCalls[0];
    expect(del.table).toBe(favorites);
    const compiled = compileQuery(del.condition);
    expect(compiled.sql).toContain('"favorites"."wecom_userid"');
    expect(compiled.sql).toContain('"favorites"."full_name"');
    expect(compiled.params).toContain('alice');
    expect(compiled.params).toContain('older/two');

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 older/two');
  });

  it('序号与「我的收藏」一致：第 1 条是最新 star 的那个', async () => {
    const fetchMock = stubGithubStars(['newest/one', 'older/two'], 2);
    seedBinding(boundSubscriberRow());

    await handleUnfavorite(makeMsg({ content: '取消收藏一' }));

    const call = deleteCall(fetchMock);
    expect(call?.[0]).toBe('https://api.github.com/user/starred/newest/one');
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 newest/one');
  });

  it('「取消收藏二」（中文数字）→ 取消第 2 条收藏', async () => {
    const fetchMock = stubGithubStars(['a/one', 'b/two'], 2);
    seedBinding(boundSubscriberRow());

    await handleUnfavorite(makeMsg({ content: '取消收藏二' }));

    expect(deleteCall(fetchMock)?.[0]).toBe(
      'https://api.github.com/user/starred/b/two',
    );
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 b/two');
  });

  it('「取消收藏 0」（序号非法）→ 用法提示，不打 GitHub、不删行', async () => {
    const fetchMock = stubFetchStatus(204);

    await handleUnfavorite(makeMsg({ content: '取消收藏 0' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNFAVORITE_USAGE_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('已绑定但 star 多于已取的前 10 条：第 26 条在本地 fallback 里同样可删（序号上限 999 不受 25 约束）', async () => {
    // GitHub 列表拉取失败 → 回退本地 favorites（30 条），序号仍按本地升序解析。
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('[]', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    seedBinding(boundSubscriberRow());
    seedFavorites(
      Array.from({ length: 30 }, (_, i) => ({
        fullName: `o/r${i + 1}`,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      })),
    );

    await handleUnfavorite(makeMsg({ content: '取消收藏 26' }));

    const call = deleteCall(fetchMock);
    expect(call?.[0]).toBe('https://api.github.com/user/starred/o/r26');
    expect(dbMock.deleteCalls).toHaveLength(1);
    const compiled = compileQuery(dbMock.deleteCalls[0]?.condition);
    expect(compiled.params).toContain('o/r26');
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 o/r26');
  });

  it('已绑定且序号超出已取的 10 条、但 star 总数更多 → 引导去 GitHub 取消，不打 DELETE、不删行', async () => {
    const fetchMock = stubGithubStars(
      Array.from({ length: 10 }, (_, i) => `o/r${i + 1}`),
      25,
    );
    seedBinding(boundSubscriberRow());

    await handleUnfavorite(makeMsg({ content: '取消收藏 15' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('第 15 个');
    expect(content).toContain('https://github.com/alice-gh?tab=stars');
    expect(deleteCall(fetchMock)).toBeUndefined();
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('「取消收藏 999」（上限内解析成功但列表不足）→ 越界文案「没有第 999 条」', async () => {
    const fetchMock = stubFetchStatus(204);
    seedBinding({ githubTokenEnc: null, githubLogin: null });
    seedFavorites([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 999' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('没有第 999 条');
    expect(fetchMock).not.toHaveBeenCalled();
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
    seedBinding({ githubTokenEnc: null, githubLogin: null });
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
    stubStarsStatus(401);
    seedBinding(boundSubscriberRow('expired'));

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(AUTH_EXPIRED_REPLY);
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  it('GitHub 其他失败状态（500）→ 回退本地序号后 unstar 仍可成功', async () => {
    // 列表 500（回退本地）→ 但 DELETE 也 500 → 通用失败文案。
    stubStarsStatus(500);
    seedBinding(boundSubscriberRow());
    seedFavorites([{ fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') }]);

    await expect(
      handleUnfavorite(makeMsg({ content: '取消收藏 1' })),
    ).resolves.toBeUndefined();

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNSTAR_FAILURE_REPLY);
    expect(dbMock.deleteCalls).toHaveLength(0);
  });

  /** 列表 500、DELETE 正常 204：验证「拉不到 GitHub 就用本地序号」仍能真正取消。 */
  it('GitHub 列表失败但 unstar 成功 → 按本地序号取消并删行', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('[]', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    seedBinding(boundSubscriberRow());
    seedFavorites([{ fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') }]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    expect(deleteCall(fetchMock)?.[0]).toBe(
      'https://api.github.com/user/starred/a/one',
    );
    expect(dbMock.deleteCalls).toHaveLength(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe('已取消收藏 a/one');
  });

  it('未绑定 → 引导绑定，不打 GitHub、不删行', async () => {
    const fetchMock = stubFetchStatus(204);
    seedBinding({ githubTokenEnc: null, githubLogin: null });
    seedFavorites([{ fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') }]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(UNBOUND_REPLY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadGithubStars：GitHub star 实时列表（最近 10 个 + 总数）
// ---------------------------------------------------------------------------
describe('loadGithubStars（GitHub star 实时列表）', () => {
  it('按 star 时间倒序取 10 条，另发一次 per_page=1 读 Link 得总数', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `o/r${i + 1}`);
    const fetchMock = stubGithubStars(names, 25);

    const result = await loadGithubStars('alice-gh', 'gho_test_token');

    expect(result).toEqual({
      kind: 'ok',
      items: names.map((fullName) => ({ fullName })),
      total: 25,
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe(
      'https://api.github.com/users/alice-gh/starred?sort=created&direction=desc&per_page=10',
    );
    expect(
      (calls[0][1].headers as Record<string, string>).authorization,
    ).toBe('Bearer gho_test_token');
    expect(calls[1][0]).toContain('per_page=1');
    expect(calls[1][0]).toContain('/users/alice-gh/starred');
  });

  it('正好 10 条但没有 Link 头 → 总数就是 10（不谎报"还有"）', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `o/r${i + 1}`);
    stubGithubStars(names, null);

    const result = await loadGithubStars('alice-gh', 'gho_test_token');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.total).toBe(10);
  });

  it('不足 10 条 → 省掉统计请求，总数 = 本次条数', async () => {
    const fetchMock = stubGithubStars(['a/one', 'b/two'], 2);

    const result = await loadGithubStars('alice-gh', 'gho_test_token');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.total).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 → auth_failed（引导重新绑定）', async () => {
    stubStarsStatus(401);
    await expect(loadGithubStars('alice-gh', 'bad')).resolves.toEqual({
      kind: 'auth_failed',
    });
  });

  it('429 / 500 → failed（绝不冒充"没有 star"）', async () => {
    stubStarsStatus(429);
    await expect(loadGithubStars('alice-gh', 't')).resolves.toEqual({
      kind: 'failed',
    });
    stubStarsStatus(500);
    await expect(loadGithubStars('alice-gh', 't')).resolves.toEqual({
      kind: 'failed',
    });
  });

  it('网络异常 → failed，不抛出', async () => {
    stubFetchNetworkError();
    await expect(loadGithubStars('alice-gh', 't')).resolves.toEqual({
      kind: 'failed',
    });
  });
});

// ---------------------------------------------------------------------------
// formatGithubStarsList：编号 + 裸链接 + 「还有 N 个」尾行
// ---------------------------------------------------------------------------
describe('formatGithubStarsList（编号 + 链接 + 总数尾行）', () => {
  it('10 条 + 总数 25 → 逐条带 GitHub 链接，末行「还有 15 个 · 在 GitHub 看全部」', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      fullName: `owner/repo-${i + 1}`,
    }));

    const text = formatGithubStarsList(items, 25, 'alice-gh');

    const lines = text.split('\n');
    expect(lines[0]).toBe('你的 star：');
    expect(lines[1]).toBe('1. owner/repo-1 https://github.com/owner/repo-1');
    expect(lines[10]).toBe('10. owner/repo-10 https://github.com/owner/repo-10');
    expect(lines[11]).toBe(
      '还有 15 个 · 在 GitHub 看全部 https://github.com/alice-gh?tab=stars',
    );
    expect(lines).toHaveLength(12);
  });

  it('总数等于条数 → 不出现「还有」尾行', () => {
    const text = formatGithubStarsList([{ fullName: 'a/one' }], 1, 'alice-gh');
    expect(text).toBe('你的 star：\n1. a/one https://github.com/a/one');
  });

  it('超长列表截断：≤1800 字节、保靠前、带截断标注，尾行的「还有 N 个」按实际展示数重算', () => {
    const long = 'x'.repeat(80);
    const items = Array.from({ length: 10 }, (_, i) => ({
      fullName: `owner${i}/${long}`,
    }));

    const text = formatGithubStarsList(items, 25, 'alice-gh');

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1800);
    expect(text).toContain('（内容过长，已截断）');
    expect(text).toContain('1. owner0/xxx');
    // 展示了几条，尾行就少几个（剩余 = 总数 - 展示数）。
    const shown = text.match(/^\d+\. /gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(10);
    expect(text).toContain(`还有 ${25 - shown} 个`);
  });
});

// ---------------------------------------------------------------------------
// handleList：我的收藏
// ---------------------------------------------------------------------------
describe('handleList（我的收藏 → 编号列表）', () => {
  /** 订阅者行入队（handleList 第一次 select）：null 表示无订阅者行。 */
  function seedBinding(row: Record<string, unknown> | null): void {
    dbMock.selectQueue.push(row === null ? [] : [row]);
  }

  it('未绑定 → 本地 favorites 按 created_at 升序：编号 + owner/repo + 创建日期 + 绑定提示', async () => {
    seedBinding({ githubTokenEnc: null, githubLogin: null });
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
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('1. a/one（2026-10-01）');
    expect(lines[2]).toBe('2. b/two（2026-10-05）');
    expect(lines[3]).toBe(UNBOUND_STARS_NOTE);
    expect(UNBOUND_STARS_NOTE).toBe('绑定 GitHub 后这里会显示你全部 star');
  });

  it('已绑定 → 直接读 GitHub star 实时列表（不读本地 favorites 表）', async () => {
    seedBinding(boundSubscriberRow());
    stubGithubStars(['o/r1', 'o/r2'], 2);

    await handleList(makeMsg({ content: '我的收藏' }));

    // 只查了一次订阅者表，没有查 favorites。
    expect(dbMock.selectCalls).toHaveLength(1);
    expect(dbMock.orderByCalls).toHaveLength(0);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('1. o/r1 https://github.com/o/r1');
    expect(content).toContain('2. o/r2 https://github.com/o/r2');
    expect(content).not.toContain(UNBOUND_STARS_NOTE);
  });

  it('已绑定且 star 为空 → 空态文案（不谎报失败）', async () => {
    seedBinding(boundSubscriberRow());
    stubGithubStars([], 0);

    await handleList(makeMsg({ content: '我的收藏' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(EMPTY_FAVORITES_REPLY);
  });

  it('已绑定但 GitHub 拉取失败（500）→ 回退本地收藏并如实说明，绝不谎报为空', async () => {
    seedBinding(boundSubscriberRow());
    stubStarsStatus(500);
    dbMock.selectQueue.push([
      { fullName: 'a/one', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);

    await handleList(makeMsg({ content: '我的收藏' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('1. a/one');
    expect(content).toContain(STARS_FALLBACK_NOTE);
    expect(content).not.toBe(EMPTY_FAVORITES_REPLY);
  });

  it('已绑定但 token 失效（401）→ 引导重新绑定', async () => {
    seedBinding(boundSubscriberRow('expired'));
    stubStarsStatus(401);

    await handleList(makeMsg({ content: '我的收藏' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toBe(AUTH_EXPIRED_REPLY);
  });

  it('空收藏 → 友好中文空态回复（不含编号列表）', async () => {
    seedBinding({ githubTokenEnc: null, githubLogin: null });
    dbMock.selectQueue.push([]);

    await handleList(makeMsg({ content: '我的收藏' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content.startsWith(EMPTY_FAVORITES_REPLY)).toBe(true);
    expect(content).toContain('收藏');
    expect(content).not.toMatch(/^\d+\./m);
  });

  it('长列表截断：总字节 ≤1800、保留靠前条目、末尾标注「（内容过长，已截断）」', async () => {
    // 40+ 条收藏：每行约 55 字节，整列表远超企微 ~2048 字节文本上限。
    seedBinding({ githubTokenEnc: null, githubLogin: null });
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
    seedBinding({ githubTokenEnc: null, githubLogin: null });
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
    stubGithubStars(['a/one'], 1);
    dbMock.selectQueue.push([{ wecomUserid: 'alice' }]); // ensureSubscriber：老用户
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
    stubGithubStars(['a/one'], 1);
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
    dbMock.selectQueue.push([{ githubTokenEnc: null, githubLogin: null }]);
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
    dbMock.selectQueue.push([
      { githubTokenEnc: 'garbage-not-encrypted', githubLogin: 'alice-gh' },
    ]);

    await handleUnfavorite(makeMsg({ content: '取消收藏 1' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      AUTH_EXPIRED_REPLY,
    );
    expect(console.warn).toHaveBeenCalledWith(
      'github token decrypt failed:',
      expect.any(Error),
    );
  });
});
