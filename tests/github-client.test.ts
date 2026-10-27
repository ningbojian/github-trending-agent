import { describe, expect, it } from 'vitest';
import {
  createGithubClient,
  parseRepoRef,
  type GithubCache,
} from '../src/github/client';

/**
 * GitHub 客户端：缓存、限流退避、超时与失败降级。
 * 全部依赖注入（fetch / sleep / now / cache），测试不碰网络与数据库。
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

class FakeCache implements GithubCache {
  readonly entries = new Map<string, CacheEntry>();
  readonly writes: string[] = [];

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.entries.get(key);
    return entry === undefined ? null : { ...entry };
  }

  async set(key: string, value: unknown, expiresAt: number): Promise<void> {
    this.writes.push(key);
    this.entries.set(key, { value, expiresAt });
  }
}

interface FakeResponseInit {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function response(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.text ?? JSON.stringify(init.json ?? {});
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function setup(responses: Array<Response | Error>, now = 1_700_000_000_000) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const cache = new FakeCache();
  const client = createGithubClient({
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => now,
    cache,
  });
  return { client, calls, sleeps, cache };
}

const REPO_JSON = {
  full_name: 'facebook/react',
  description: 'The library for web and native user interfaces.',
  language: 'JavaScript',
  stargazers_count: 240000,
  forks_count: 49000,
  open_issues_count: 800,
  pushed_at: '2026-10-26T12:00:00Z',
  created_at: '2013-05-24T16:15:54Z',
  archived: false,
  license: { spdx_id: 'MIT' },
  topics: ['react'],
  default_branch: 'main',
  html_url: 'https://github.com/facebook/react',
};

describe('parseRepoRef — 仓库引用', () => {
  it('接受 owner/repo', () => {
    expect(parseRepoRef('facebook/react')).toEqual({ owner: 'facebook', name: 'react' });
  });

  it('接受完整链接（含子路径与查询串）', () => {
    expect(parseRepoRef('https://github.com/facebook/react/tree/main/packages?x=1')).toEqual({
      owner: 'facebook',
      name: 'react',
    });
  });

  it('剥掉首尾空白与尾斜杠', () => {
    expect(parseRepoRef('  facebook/react/  ')).toEqual({ owner: 'facebook', name: 'react' });
  });

  it('接受 .git 后缀', () => {
    expect(parseRepoRef('facebook/react.git')).toEqual({ owner: 'facebook', name: 'react' });
  });

  it('拒绝缺少仓库名或非法字符', () => {
    expect(parseRepoRef('facebook')).toBeNull();
    expect(parseRepoRef('facebook/')).toBeNull();
    expect(parseRepoRef('facebook/re act')).toBeNull();
    expect(parseRepoRef('')).toBeNull();
  });

  it('拒绝非 github 链接', () => {
    expect(parseRepoRef('https://gitlab.com/facebook/react')).toBeNull();
  });
});

describe('GitHub 客户端 — 读取与缓存', () => {
  it('成功读取仓库并缓存 6 小时', async () => {
    const { client, calls, cache } = setup([response({ json: REPO_JSON })]);
    const result = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fullName).toBe('facebook/react');
      expect(result.data.stars).toBe(240000);
      expect(result.cached).toBe(false);
    }
    expect(calls).toHaveLength(1);
    expect(cache.entries.get('gh:repo:v1:facebook/react')?.expiresAt).toBe(
      1_700_000_000_000 + 6 * 60 * 60 * 1000,
    );
  });

  it('第二次读取命中缓存，不再请求', async () => {
    const { client, calls } = setup([response({ json: REPO_JSON })]);
    await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    const second = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(calls).toHaveLength(1);
    expect(second.ok && second.cached).toBe(true);
  });

  it('缓存键大小写不敏感', async () => {
    const { client, calls } = setup([response({ json: REPO_JSON })]);
    await client.getRepo({ owner: 'Facebook', name: 'React' }, 'tok');
    await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(calls).toHaveLength(1);
  });

  it('404 返回 not-found，且不写缓存（下次要重新确认）', async () => {
    const { client, cache } = setup([response({ status: 404, json: {} })]);
    const result = await client.getRepo({ owner: 'ghost', name: 'repo' }, null);
    expect(result).toEqual({ ok: false, failure: 'not-found', message: 'HTTP 404' });
    expect(cache.writes).toEqual([]);
  });

  it('限流按 retry-after 等待后重试', async () => {
    const { client, sleeps } = setup([
      response({ status: 429, headers: { 'retry-after': '2' } }),
      response({ json: REPO_JSON }),
    ]);
    const result = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([2000]);
  });

  it('连续限流耗尽 3 次尝试 → rate-limited', async () => {
    const { client, sleeps } = setup([
      response({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      response({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      response({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    ]);
    const result = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('rate-limited');
    // 没有 retry-after 时用指数退避（1s、2s）
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('网络异常 → error，不抛给调用方', async () => {
    const { client } = setup([new Error('ECONNRESET')]);
    const result = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('error');
      expect(result.message).toContain('ECONNRESET');
    }
  });

  it('请求失败时用过期缓存兜底（stale）', async () => {
    const { client, cache } = setup([new Error('boom')]);
    cache.entries.set('gh:repo:v1:facebook/react', {
      value: {
        fullName: 'facebook/react',
        description: null,
        language: 'JavaScript',
        stars: 240000,
        forks: 49000,
        openIssues: 800,
        pushedAt: '2026-10-26T12:00:00Z',
        createdAt: '2013-05-24T16:15:54Z',
        archived: false,
        license: 'MIT',
        topics: [],
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/facebook/react',
      },
      expiresAt: 1_600_000_000_000,
    });
    const result = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cached).toBe(true);
      expect(result.stale).toBe(true);
    }
  });

  it('缓存内容形状不对视为未命中', async () => {
    const { client, calls, cache } = setup([response({ json: REPO_JSON })]);
    cache.entries.set('gh:repo:v1:facebook/react', {
      value: { nonsense: true },
      expiresAt: 1_700_000_100_000,
    });
    const result = await client.getRepo({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('GitHub 客户端 — readme / releases / commits', () => {
  it('readme 取纯文本并缓存 24 小时，超长截断', async () => {
    const long = 'x'.repeat(20_000);
    const { client, cache } = setup([response({ text: long })]);
    const result = await client.getReadme({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.length).toBe(8000);
    }
    expect(cache.entries.get('gh:readme:v1:facebook/react')?.expiresAt).toBe(
      1_700_000_000_000 + 24 * 60 * 60 * 1000,
    );
  });

  it('没有 readme → ok + null（不是失败）', async () => {
    const { client } = setup([response({ status: 404, json: {} })]);
    const result = await client.getReadme({ owner: 'ghost', name: 'repo' }, null);
    expect(result).toEqual({ ok: true, data: null, cached: false });
  });

  it('releases 只保留工具要用的字段并缓存 6 小时', async () => {
    const { client } = setup([
      response({
        json: [
          {
            tag_name: 'v19.0.0',
            name: 'React 19',
            published_at: '2026-09-01T00:00:00Z',
            prerelease: false,
            body: 'notes',
          },
          { tag_name: 'v19.0.0-rc', published_at: '2026-08-01T00:00:00Z', prerelease: true },
        ],
      }),
    ]);
    const result = await client.getReleases({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { tag: 'v19.0.0', name: 'React 19', publishedAt: '2026-09-01T00:00:00Z', prerelease: false },
        { tag: 'v19.0.0-rc', name: null, publishedAt: '2026-08-01T00:00:00Z', prerelease: true },
      ]);
    }
  });

  it('commits 取最近 5 条并只留首行消息', async () => {
    const { client, calls } = setup([
      response({
        json: [
          {
            sha: 'abc123',
            commit: {
              message: 'Fix something\n\nlong body',
              author: { date: '2026-10-26T00:00:00Z' },
            },
            author: { login: 'octocat' },
          },
        ],
      }),
    ]);
    const result = await client.getCommits({ owner: 'facebook', name: 'react' }, 'tok');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { sha: 'abc123', message: 'Fix something', author: 'octocat', date: '2026-10-26T00:00:00Z' },
      ]);
    }
    expect(calls[0]).toContain('/repos/facebook/react/commits?per_page=5');
  });

  it('请求头带 token 与 API 版本；匿名时不带 Authorization', async () => {
    const headers: Array<Record<string, string>> = [];
    const client = createGithubClient({
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        headers.push(init?.headers as Record<string, string>);
        return response({ json: REPO_JSON });
      }) as typeof fetch,
      cache: new FakeCache(),
    });
    await client.getRepo({ owner: 'a', name: 'b' }, 'secret-token');
    await client.getRepo({ owner: 'a', name: 'c' }, null);
    expect(headers[0]?.Authorization).toBe('Bearer secret-token');
    expect(headers[1]?.Authorization).toBeUndefined();
    expect(headers[0]?.['X-GitHub-Api-Version']).toBe('2022-11-28');
  });
});
