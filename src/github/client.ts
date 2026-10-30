import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { parseRepoRef, type RepoRef } from './repo-ref.js';

export { parseRepoRef };
export type { RepoRef };

/**
 * GitHub REST 只读客户端。
 *
 * 设计约束：
 * - **6 秒超时**：工具循环整体只有 15 秒，单个请求不能把预算吃光。
 * - **限流按 retry-after 退避**，最多 3 次尝试；耗尽就如实返回 rate-limited，
 *   由工具层告诉用户「稍后再试」，绝不假装成「没有数据」。
 * - **失败不写缓存**，但**过期缓存可以兜底**（stale=true）：多给一天前的
 *   star 数，也比工具直接失败有用。
 * - 所有读写都走 `kv_cache`（零迁移）；缓存键带 `v1`，改语义时整体失效。
 * - 这里不发消息、不拼文案、不读用户设置——那些是 tools / handler 的事。
 */

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const README_MAX_CHARS = 8_000;

export const REPO_TTL_MS = 6 * 60 * 60 * 1000;
export const README_TTL_MS = 24 * 60 * 60 * 1000;
export const RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
export const COMMITS_TTL_MS = 2 * 60 * 60 * 1000;

export type GithubFailure = 'not-found' | 'rate-limited' | 'error';

export type GithubResult<T> =
  | { ok: true; data: T; cached: boolean; stale?: boolean }
  | { ok: false; failure: GithubFailure; message: string };

export interface CacheEntry {
  value: unknown;
  /** 毫秒时间戳。 */
  expiresAt: number;
}

export interface GithubCache {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: unknown, expiresAt: number): Promise<void>;
}

export interface GithubClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cache?: GithubCache;
}

export interface RepoInfo {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  createdAt: string | null;
  archived: boolean;
  license: string | null;
  topics: string[];
  defaultBranch: string;
  htmlUrl: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface GithubClient {
  getRepo(ref: RepoRef, token: string | null): Promise<GithubResult<RepoInfo>>;
  getReadme(ref: RepoRef, token: string | null): Promise<GithubResult<string | null>>;
  getReleases(ref: RepoRef, token: string | null): Promise<GithubResult<ReleaseInfo[]>>;
  getCommits(ref: RepoRef, token: string | null): Promise<GithubResult<CommitInfo[]>>;
}

function repoKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 缓存值形状校验：不认识的形状当作未命中，绝不让脏缓存进工具。 */
function parseRepoInfo(value: unknown): RepoInfo | undefined {
  if (!isRecord(value)) return undefined;
  const fullName = asString(value.fullName);
  const stars = asNumber(value.stars);
  const forks = asNumber(value.forks);
  if (fullName === null || stars === null || forks === null) return undefined;
  return {
    fullName,
    description: asString(value.description),
    language: asString(value.language),
    stars,
    forks,
    openIssues: asNumber(value.openIssues) ?? 0,
    pushedAt: asString(value.pushedAt),
    createdAt: asString(value.createdAt),
    archived: value.archived === true,
    license: asString(value.license),
    topics: Array.isArray(value.topics)
      ? value.topics.filter((topic): topic is string => typeof topic === 'string')
      : [],
    defaultBranch: asString(value.defaultBranch) ?? 'main',
    htmlUrl: asString(value.htmlUrl) ?? `https://github.com/${fullName}`,
  };
}

function parseReleases(value: unknown): ReleaseInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      tag: asString(record.tag) ?? '',
      name: asString(record.name),
      publishedAt: asString(record.publishedAt),
      prerelease: record.prerelease === true,
    };
  });
}

function parseCommits(value: unknown): CommitInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      sha: asString(record.sha) ?? '',
      message: asString(record.message) ?? '',
      author: asString(record.author),
      date: asString(record.date),
    };
  });
}

/**
 * 缓存值形状校验：不认识的形状当作**未命中**（`undefined`），
 * 认识但没有 README（`null`）当作**命中且为空**。
 *
 * 这个区分是必需的：`cached()` 用 `cachedValue !== undefined` 判断是否命中，
 * 若把 `null` 也返回 `undefined`，「确认这个仓库没有 README」这个事实就无法
 * 被缓存——每次深挖都重新打一次 GitHub。症状很隐蔽：功能都正常，只是白花
 * API 配额，而且仓库没有 README 的情况并不少见。
 */
function parseReadme(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** 默认缓存实现：kv_cache，读写失败都降级为「没缓存」。 */
export const kvGithubCache: GithubCache = {
  async get(key) {
    try {
      const rows = await db()
        .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
        .from(kvCache)
        .where(eq(kvCache.key, key))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { value: row.value, expiresAt: row.expiresAt.getTime() };
    } catch (err) {
      console.warn('[github] cache read failed:', err instanceof Error ? err.message : err);
      return null;
    }
  },
  async set(key, value, expiresAt) {
    try {
      await db()
        .insert(kvCache)
        .values({ key, value: value as never, expiresAt: new Date(expiresAt) })
        .onConflictDoUpdate({
          target: kvCache.key,
          set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
        });
    } catch (err) {
      console.warn('[github] cache write failed:', err instanceof Error ? err.message : err);
    }
  },
};

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number.parseInt(header, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // 上限 10 秒：工具循环只有 15 秒，不能把预算睡光。
      return Math.min(seconds * 1000, 10_000);
    }
  }
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

interface RequestOptions<T> {
  token: string | null;
  accept?: string;
  parse: (response: Response) => Promise<T>;
  /** 404 当成功返回 null（readme 不存在是正常情况）。 */
  notFoundAsNull?: boolean;
}

export function createGithubClient(options: GithubClientOptions = {}): GithubClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const cache = options.cache ?? kvGithubCache;

  async function request<T>(
    path: string,
    requestOptions: RequestOptions<T>,
  ): Promise<GithubResult<T | null>> {
    const headers: Record<string, string> = {
      Accept: requestOptions.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (requestOptions.token !== null) {
      headers.Authorization = `Bearer ${requestOptions.token}`;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(`${API_BASE}${path}`, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        return {
          ok: false,
          failure: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (response.status === 404) {
        if (requestOptions.notFoundAsNull === true) {
          return { ok: true, data: null, cached: false };
        }
        return { ok: false, failure: 'not-found', message: 'HTTP 404' };
      }

      if (response.status === 403 || response.status === 429) {
        if (attempt >= MAX_ATTEMPTS) {
          return { ok: false, failure: 'rate-limited', message: 'HTTP 429' };
        }
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      if (!response.ok) {
        return { ok: false, failure: 'error', message: `HTTP ${response.status}` };
      }

      try {
        return { ok: true, data: await requestOptions.parse(response), cached: false };
      } catch (err) {
        return {
          ok: false,
          failure: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: false, failure: 'rate-limited', message: 'HTTP 429' };
  }

  async function cached<T>(
    key: string,
    ttlMs: number,
    parseCache: (value: unknown) => T | undefined,
    fetcher: () => Promise<GithubResult<T>>,
  ): Promise<GithubResult<T>> {
    const entry = await cache.get(key);
    const current = now();
    const cachedValue = entry === null ? undefined : parseCache(entry.value);
    if (entry !== null && cachedValue !== undefined && entry.expiresAt > current) {
      return { ok: true, data: cachedValue, cached: true };
    }

    const result = await fetcher();
    if (result.ok) {
      await cache.set(key, result.data, current + ttlMs);
      return { ...result, cached: false };
    }

    // 404 是确定事实，不用过期数据兜底；限流/网络错误才值得退回旧值。
    if (result.failure !== 'not-found' && cachedValue !== undefined) {
      return { ok: true, data: cachedValue, cached: true, stale: true };
    }
    return result;
  }

  function repoPath(ref: RepoRef, suffix = ''): string {
    return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
  }

  return {
    async getRepo(ref, token) {
      return cached(
        `gh:repo:v1:${repoKey(ref)}`,
        REPO_TTL_MS,
        parseRepoInfo,
        async () => {
          const result = await request(repoPath(ref), {
            token,
            parse: async (response) => {
              const body = (await response.json()) as Record<string, unknown>;
              const license =
                isRecord(body.license) ? asString(body.license.spdx_id) : null;
              return {
                fullName: asString(body.full_name) ?? `${ref.owner}/${ref.name}`,
                description: asString(body.description),
                language: asString(body.language),
                stars: asNumber(body.stargazers_count) ?? 0,
                forks: asNumber(body.forks_count) ?? 0,
                openIssues: asNumber(body.open_issues_count) ?? 0,
                pushedAt: asString(body.pushed_at),
                createdAt: asString(body.created_at),
                archived: body.archived === true,
                license,
                topics: Array.isArray(body.topics)
                  ? body.topics.filter((topic): topic is string => typeof topic === 'string')
                  : [],
                defaultBranch: asString(body.default_branch) ?? 'main',
                htmlUrl: asString(body.html_url) ?? `https://github.com/${ref.owner}/${ref.name}`,
              };
            },
          });
          return result.ok
            ? { ok: true, data: result.data as RepoInfo, cached: false }
            : result;
        },
      );
    },

    async getReadme(ref, token) {
      return cached(
        `gh:readme:v1:${repoKey(ref)}`,
        README_TTL_MS,
        parseReadme,
        async () => {
          const result = await request(repoPath(ref, '/readme'), {
            token,
            accept: 'application/vnd.github.raw+json',
            notFoundAsNull: true,
            parse: async (response) => response.text(),
          });
          if (!result.ok) return result;
          const text = result.data;
          return {
            ok: true,
            data: text === null ? null : text.slice(0, README_MAX_CHARS),
            cached: false,
          };
        },
      );
    },

    async getReleases(ref, token) {
      return cached(
        `gh:releases:v1:${repoKey(ref)}`,
        RELEASES_TTL_MS,
        parseReleases,
        async () => {
          const result = await request(repoPath(ref, '/releases?per_page=3'), {
            token,
            parse: async (response) => {
              const body = (await response.json()) as unknown;
              if (!Array.isArray(body)) return [];
              return body.map((item) => {
                const record = isRecord(item) ? item : {};
                return {
                  tag: asString(record.tag_name) ?? '',
                  name: asString(record.name),
                  publishedAt: asString(record.published_at),
                  prerelease: record.prerelease === true,
                };
              });
            },
          });
          return result.ok
            ? { ok: true, data: result.data as ReleaseInfo[], cached: false }
            : result;
        },
      );
    },

    async getCommits(ref, token) {
      return cached(
        `gh:commits:v1:${repoKey(ref)}`,
        COMMITS_TTL_MS,
        parseCommits,
        async () => {
          const result = await request(repoPath(ref, '/commits?per_page=5'), {
            token,
            parse: async (response) => {
              const body = (await response.json()) as unknown;
              if (!Array.isArray(body)) return [];
              return body.map((item) => {
                const record = isRecord(item) ? item : {};
                const commit = isRecord(record.commit) ? record.commit : {};
                const author = isRecord(record.author) ? record.author : {};
                const fullMessage = asString(commit.message) ?? '';
                return {
                  sha: asString(record.sha) ?? '',
                  message: fullMessage.split('\n')[0] ?? '',
                  author: asString(author.login),
                  date: isRecord(commit.author) ? asString(commit.author.date) : null,
                };
              });
            },
          });
          return result.ok
            ? { ok: true, data: result.data as CommitInfo[], cached: false }
            : result;
        },
      );
    },
  };
}

/** 生产用单例（默认 deps：全局 fetch + kv_cache 缓存）。 */
export const githubClient: GithubClient = createGithubClient();
