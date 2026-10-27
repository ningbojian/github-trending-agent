import { describe, expect, it } from 'vitest';
import type { CommitInfo, GithubClient, ReleaseInfo, RepoInfo } from '../src/github/client';
import {
  TOOL_MAX_TOP_N,
  toolDeepDiveRepo,
  toolManageSubscription,
  toolRepoHealth,
  toolSearchTrending,
  type ToolContext,
} from '../src/agent/tools';
import type { SearchQuery } from '../src/agent/parse-query';
import type { SubscriptionSnapshot } from '../src/agent/subscription-store';

/**
 * 工具层：参数收窄、失败分类、只读约束。
 * GitHub 客户端与订阅存储全部注入，测试不碰网络与数据库。
 */

const NOW = Date.parse('2026-10-27T00:00:00Z');

const REPO: RepoInfo = {
  fullName: 'astral-sh/ruff',
  description: 'An extremely fast Python linter.',
  language: 'Rust',
  stars: 40_000,
  forks: 1_400,
  openIssues: 1_200,
  pushedAt: '2026-10-25T00:00:00Z',
  createdAt: '2022-08-09T00:00:00Z',
  archived: false,
  license: 'MIT',
  topics: ['python'],
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/astral-sh/ruff',
};

const RELEASES: ReleaseInfo[] = [
  { tag: 'v0.14.0', name: 'v0.14.0', publishedAt: '2026-10-01T00:00:00Z', prerelease: false },
];

const COMMITS: CommitInfo[] = [
  { sha: 'abc123', message: 'Fix something', author: 'charliermarsh', date: '2026-10-26T00:00:00Z' },
];

interface Calls {
  fetch: string[];
  search: SearchQuery[];
  writes: string[];
}

function fakeGithub(overrides: Partial<GithubClient> = {}): { client: GithubClient; calls: Calls } {
  const calls: Calls = { fetch: [], search: [], writes: [] };
  const client: GithubClient = {
    async getRepo() {
      calls.fetch.push('repo');
      return { ok: true, data: REPO, cached: false };
    },
    async getReadme() {
      calls.fetch.push('readme');
      return { ok: true, data: '# Ruff\nfast linter', cached: false };
    },
    async getReleases() {
      calls.fetch.push('releases');
      return { ok: true, data: RELEASES, cached: false };
    },
    async getCommits() {
      calls.fetch.push('commits');
      return { ok: true, data: COMMITS, cached: false };
    },
    ...overrides,
  };
  return { client, calls };
}

function context(
  github: GithubClient,
  options: {
    calls?: Calls;
    subscription?: SubscriptionSnapshot | null;
    removeResult?: { removed: boolean; keywords: string[] };
    removeThrows?: boolean;
  } = {},
): ToolContext {
  const calls = options.calls ?? { fetch: [], search: [], writes: [] };
  return {
    wecomUserid: 'zhangsan',
    now: () => NOW,
    github,
    search: async (query) => {
      calls.search.push(query);
      return [];
    },
    getToken: async () => ({ token: 'tok', source: 'user' }),
    readSubscription: async () => (options.subscription === undefined ? null : options.subscription),
    removeTerm: async (_userid, term) => {
      calls.writes.push(term);
      if (options.removeThrows === true) throw new Error('db down');
      return options.removeResult ?? { removed: false, keywords: [] };
    },
  };
}

describe('search_trending', () => {
  it('把参数收窄成 SearchQuery（topN 上限 10、语言小写、空关键词丢弃）', async () => {
    const { client, calls } = fakeGithub();
    const ctx = context(client, { calls });
    await toolSearchTrending(
      { keywords: ['ai', '  ', 'Agent'], languages: ['Python'], period: 'month', topN: 50 },
      ctx,
    );
    expect(TOOL_MAX_TOP_N).toBe(10);
    expect(calls.search[0]).toEqual({
      intent: 'search',
      keywords: ['ai', 'Agent'],
      languages: ['python'],
      period: 'month',
      minStars: null,
      sortBy: 'stars_delta',
      topN: 10,
    });
  });

  it('topN 过小取 1；缺省 10', async () => {
    const { client, calls } = fakeGithub();
    const ctx = context(client, { calls });
    await toolSearchTrending({ topN: 0 }, ctx);
    await toolSearchTrending({}, ctx);
    expect(calls.search.map((q) => q.topN)).toEqual([1, 10]);
  });

  it('返回结果条数与查询，供路由侧复用同一份列表', async () => {
    const { client } = fakeGithub();
    const ctx = context(client);
    const result = await toolSearchTrending({ keywords: ['ruff'] }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query.keywords).toEqual(['ruff']);
      expect(result.items).toEqual([]);
    }
  });

  it('检索抛错 → error，不把异常抛给模型循环', async () => {
    const { client } = fakeGithub();
    const ctx = { ...context(client), search: async () => { throw new Error('db down'); } };
    const result = await toolSearchTrending({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('error');
  });
});

describe('deep_dive_repo', () => {
  it('成功时返回仓库、健康度、readme、最近发布与提交', async () => {
    const { client } = fakeGithub();
    const result = await toolDeepDiveRepo({ repo: 'astral-sh/ruff' }, context(client));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo.fullName).toBe('astral-sh/ruff');
      expect(result.health.verdict).toBe('healthy');
      expect(result.readme).toContain('Ruff');
      expect(result.releases[0]?.tag).toBe('v0.14.0');
      expect(result.commits[0]?.sha).toBe('abc123');
      expect(result.notes).toEqual([]);
    }
  });

  it('非法仓库引用 → invalid-repo，且不请求 GitHub', async () => {
    const { client, calls } = fakeGithub();
    const result = await toolDeepDiveRepo({ repo: '随便写点什么' }, context(client, { calls }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('invalid-repo');
    expect(calls.fetch).toEqual([]);
  });

  it('仓库不存在 → not-found', async () => {
    const { client } = fakeGithub({
      getRepo: async () => ({ ok: false, failure: 'not-found', message: 'HTTP 404' }),
    });
    const result = await toolDeepDiveRepo({ repo: 'ghost/repo' }, context(client));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('not-found');
      expect(result.message).toContain('没找到');
    }
  });

  it('readme 失败不影响主结果，只在 notes 里说明', async () => {
    const { client } = fakeGithub({
      getReadme: async () => ({ ok: false, failure: 'rate-limited', message: 'HTTP 429' }),
    });
    const result = await toolDeepDiveRepo({ repo: 'astral-sh/ruff' }, context(client));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readme).toBeNull();
      expect(result.notes.some((note) => note.includes('readme'))).toBe(true);
    }
  });

  it('限流时如实说限流，不说成「没找到」', async () => {
    const { client } = fakeGithub({
      getRepo: async () => ({ ok: false, failure: 'rate-limited', message: 'HTTP 429' }),
    });
    const result = await toolDeepDiveRepo({ repo: 'astral-sh/ruff' }, context(client));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('rate-limited');
      expect(result.message).toContain('限流');
    }
  });
});

describe('repo_health', () => {
  it('只取仓库/发布/提交，不拉 readme', async () => {
    const { client, calls } = fakeGithub();
    const result = await toolRepoHealth({ repo: 'astral-sh/ruff' }, context(client, { calls }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.health.verdict).toBe('healthy');
      expect(result.health.facts.daysSincePush).toBe(2);
    }
    expect(calls.fetch).not.toContain('readme');
    expect(calls.fetch.sort()).toEqual(['commits', 'releases', 'repo']);
  });

  it('非法引用 → invalid-repo', async () => {
    const { client } = fakeGithub();
    const result = await toolRepoHealth({ repo: 'nope' }, context(client));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('invalid-repo');
  });
});

describe('manage_subscription', () => {
  it('show：只读展示，不写库', async () => {
    const { client, calls } = fakeGithub();
    const result = await toolManageSubscription(
      { action: 'show' },
      context(client, {
        calls,
        subscription: { active: true, preferences: { pushTime: '08:00', keywords: ['rpa'] } },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'show') {
      expect(result.summary).toContain('08:00');
      expect(result.summary).toContain('rpa');
    }
    expect(calls.writes).toEqual([]);
  });

  it('show：没有订阅者行时如实说「还没有订阅」', async () => {
    const { client } = fakeGithub();
    const result = await toolManageSubscription({ action: 'show' }, context(client));
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'show') {
      expect(result.summary).toContain('还没有订阅');
    }
  });

  it('remove_term：删掉关键词并回报剩余', async () => {
    const { client, calls } = fakeGithub();
    const result = await toolManageSubscription(
      { action: 'remove_term', term: 'RPA' },
      context(client, { calls, removeResult: { removed: true, keywords: ['ai'] } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'remove_term') {
      expect(result.removed).toBe(true);
      expect(result.keywords).toEqual(['ai']);
    }
    expect(calls.writes).toEqual(['RPA']);
  });

  it('remove_term：没命中就如实说没找到', async () => {
    const { client } = fakeGithub();
    const result = await toolManageSubscription(
      { action: 'remove_term', term: 'go' },
      context(client, { removeResult: { removed: false, keywords: ['ai'] } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'remove_term') expect(result.removed).toBe(false);
  });

  it('remove_term 缺 term → missing-term', async () => {
    const { client, calls } = fakeGithub();
    const result = await toolManageSubscription({ action: 'remove_term' }, context(client, { calls }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('missing-term');
    expect(calls.writes).toEqual([]);
  });

  it('写库失败 → error，不谎称已删', async () => {
    const { client } = fakeGithub();
    const result = await toolManageSubscription(
      { action: 'remove_term', term: 'rpa' },
      context(client, { removeThrows: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('error');
  });
});
