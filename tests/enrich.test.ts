import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repos } from '../src/db/schema';
import { enrichMissingTopics } from '../src/github/enrich';

type RepoRow = typeof repos.$inferSelect;

interface GitHubRepoBody {
  topics: string[];
  description: string | null;
  language: string | null;
  stargazers_count: number;
}

/** 构造 GET /repos/{owner}/{repo} 的 200 JSON 响应。 */
function apiResponse(overrides: Partial<GitHubRepoBody> = {}): Response {
  const body: GitHubRepoBody = {
    topics: ['ai', 'agent'],
    description: 'From the API',
    language: 'Go',
    stargazers_count: 4242,
    ...overrides,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 限流响应：403/429 + x-ratelimit-remaining: 0。 */
function rateLimitedResponse(status: 403 | 429 = 403): Response {
  return new Response('rate limited', {
    status,
    headers: { 'x-ratelimit-remaining': '0' },
  });
}

function notFoundResponse(): Response {
  return new Response('Not Found', { status: 404 });
}

/** 构造 repos 表行：默认 topics 空、description/language 空、stars 0。 */
function makeRow(overrides: Partial<RepoRow> & { fullName: string }): RepoRow {
  const [owner = '', name = ''] = overrides.fullName.split('/');
  return {
    name,
    owner,
    description: null,
    language: null,
    topics: [],
    stars: 0,
    htmlUrl: `https://github.com/${overrides.fullName}`,
    ...overrides,
  };
}

const dbState = vi.hoisted(() => ({
  dbCalls: 0,
  selectCalls: 0,
  // 测试桩：宽松记录行数据，避免过度拟合 drizzle 内部类型。
  selectRows: [] as Array<Record<string, unknown>>,
  updateLog: [] as Array<{
    table: unknown;
    set?: Record<string, unknown>;
    where?: unknown;
  }>,
}));

vi.mock('../src/db/client', () => ({
  db: () => {
    dbState.dbCalls += 1;
    return {
      select: () => ({
        from: () => ({
          where: () => {
            dbState.selectCalls += 1;
            return Promise.resolve([...dbState.selectRows]);
          },
        }),
      }),
      update: (table: unknown) => {
        const call: (typeof dbState.updateLog)[number] = { table };
        const chain = {
          set(values: Record<string, unknown>) {
            call.set = values;
            return chain;
          },
          where(condition: unknown) {
            call.where = condition;
            dbState.updateLog.push(call);
            return Promise.resolve();
          },
        };
        return chain;
      },
    };
  },
}));

const authHeaders = {
  Authorization: 'Bearer test-token',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dbState.dbCalls = 0;
  dbState.selectCalls = 0;
  dbState.selectRows = [];
  dbState.updateLog = [];
  // 静默 console.warn，保持测试输出干净；具体断言用 vi.mocked(console.warn)。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 在假时钟下跑 enrichMissingTopics：反复推进虚拟时间直到 promise 完成
 * （覆盖 1s+2s 的指数退避），避免真实等待。
 */
async function runWithFakeTimers(
  fullNames: string[],
  token: string,
): Promise<number> {
  vi.useFakeTimers();
  try {
    let done = false;
    const promise = enrichMissingTopics(fullNames, token).then((value) => {
      done = true;
      return value;
    });
    for (let i = 0; i < 20 && !done; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe('enrichMissingTopics', () => {
  it('正常补全 2 条：写回 topics/description/language/stars 并带 token 头', async () => {
    dbState.selectRows = [
      makeRow({ fullName: 'vercel/next.js' }),
      makeRow({ fullName: 'facebook/react' }),
    ];
    fetchMock
      .mockResolvedValueOnce(
        apiResponse({
          topics: ['framework', 'ssr'],
          description: 'The web framework for production',
          language: 'JavaScript',
          stargazers_count: 128000,
        }),
      )
      .mockResolvedValueOnce(
        apiResponse({
          topics: ['ui'],
          description: 'A JavaScript library for building user interfaces',
          language: 'JavaScript',
          stargazers_count: 230000,
        }),
      );

    const processed = await enrichMissingTopics(
      ['vercel/next.js', 'facebook/react'],
      'test-token',
    );

    expect(processed).toBe(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/vercel/next.js',
      { headers: authHeaders },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/facebook/react',
      { headers: authHeaders },
    );
    expect(dbState.updateLog).toHaveLength(2);
    expect(dbState.updateLog[0]?.table).toBe(repos);
    expect(dbState.updateLog[0]?.set).toEqual({
      topics: ['framework', 'ssr'],
      description: 'The web framework for production',
      language: 'JavaScript',
      stars: 128000,
    });
    expect(dbState.updateLog[1]?.set).toEqual({
      topics: ['ui'],
      description: 'A JavaScript library for building user interfaces',
      language: 'JavaScript',
      stars: 230000,
    });
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it('只填空字段：不覆盖 trending 页已抓取的 description/language/stars', async () => {
    dbState.selectRows = [
      makeRow({
        fullName: 'vercel/next.js',
        description: 'from the trending page',
        language: 'TypeScript',
        stars: 999,
      }),
    ];
    fetchMock.mockResolvedValueOnce(apiResponse());

    const processed = await enrichMissingTopics(['vercel/next.js'], 'test-token');

    expect(processed).toBe(1);
    expect(dbState.updateLog).toHaveLength(1);
    // 只写 topics——页面已有的三个字段绝不覆盖。
    expect(dbState.updateLog[0]?.set).toEqual({ topics: ['ai', 'agent'] });
  });

  it('topics 已非空的仓库不调 API、不写库', async () => {
    dbState.selectRows = [
      makeRow({
        fullName: 'vercel/next.js',
        topics: ['ssr'],
        description: 'already enriched',
        language: 'TypeScript',
        stars: 128000,
      }),
      makeRow({ fullName: 'facebook/react' }),
    ];
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        topics: ['ui'],
        description: null,
        language: null,
        stargazers_count: 0,
      }),
    );

    const processed = await enrichMissingTopics(
      ['vercel/next.js', 'facebook/react'],
      'test-token',
    );

    expect(processed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/facebook/react',
    );
    expect(dbState.updateLog).toHaveLength(1);
    expect(dbState.updateLog[0]?.set).toEqual({ topics: ['ui'] });
  });

  it('404 静默跳过：不写库、不告警、不计入补全数', async () => {
    dbState.selectRows = [makeRow({ fullName: 'gone/renamed-repo' })];
    fetchMock.mockResolvedValueOnce(notFoundResponse());

    const processed = await enrichMissingTopics(
      ['gone/renamed-repo'],
      'test-token',
    );

    expect(processed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbState.updateLog).toHaveLength(0);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it('403 限流耗尽：指数退避最多 3 次尝试，返回已补数并告警，不抛异常', async () => {
    dbState.selectRows = [
      makeRow({ fullName: 'vercel/next.js' }),
      makeRow({ fullName: 'gone/rate-limited' }),
    ];
    fetchMock
      .mockResolvedValueOnce(apiResponse({ topics: ['ssr'] }))
      .mockResolvedValue(rateLimitedResponse());

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let processed = -1;
    let error: unknown;
    try {
      let done = false;
      const promise = enrichMissingTopics(
        ['vercel/next.js', 'gone/rate-limited'],
        'test-token',
      ).then((value) => {
        done = true;
        return value;
      });
      for (let i = 0; i < 20 && !done; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      processed = await promise;
    } catch (e) {
      error = e;
    } finally {
      vi.useRealTimers();
    }

    expect(error).toBeUndefined();
    // 第一条成功补全，第二条限流耗尽——返回"已补数"。
    expect(processed).toBe(1);
    // 1 次成功 + 限流仓库 3 次尝试。
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === 'https://api.github.com/repos/gone/rate-limited',
      ),
    ).toHaveLength(3);
    expect(dbState.updateLog).toHaveLength(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('rate limit'),
    );

    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number');
    setTimeoutSpy.mockRestore();
    // 两次退避等待：base、base*2 —— 指数增长。
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBe((delays[0] ?? 0) * 2);
  });

  it('限流后重试成功：退避一次即补全，不告警', async () => {
    dbState.selectRows = [makeRow({ fullName: 'vercel/next.js' })];
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(429))
      .mockResolvedValueOnce(apiResponse({ topics: ['ssr'] }));

    const processed = await runWithFakeTimers(['vercel/next.js'], 'test-token');

    expect(processed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dbState.updateLog).toHaveLength(1);
    // 行完全为空，API 数据四个字段全部兜底写入。
    expect(dbState.updateLog[0]?.set).toEqual({
      topics: ['ssr'],
      description: 'From the API',
      language: 'Go',
      stars: 4242,
    });
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it('空 fullNames 直接返回 0，不触库不请求', async () => {
    const processed = await enrichMissingTopics([], 'test-token');

    expect(processed).toBe(0);
    expect(dbState.dbCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
