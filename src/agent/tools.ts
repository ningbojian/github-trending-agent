import { tool } from 'ai';
import { z } from 'zod';
import {
  parseRepoRef,
  type CommitInfo,
  type GithubClient,
  type ReleaseInfo,
  type RepoInfo,
} from '../github/client.js';
import type { SearchQuery } from './parse-query.js';
import type { SearchResultItem } from './search.js';
import type { SubscriptionSnapshot } from './subscription-store.js';
import { formatSubscriptionSummary } from './subscription-summary.js';
import { computeRepoHealth, type RepoHealth } from './repo-health.js';

/**
 * 工具层：模型能调用、但**不能自己算**的四件事。
 *
 * - `search_trending`：查库（会写 search_caches，编号因此和后续「收藏 N」一致）
 * - `deep_dive_repo`：仓库事实 + readme + 最近发布/提交 + 健康度
 * - `repo_health`：只要健康度（不拉 readme，省一次请求）
 * - `manage_subscription`：看设置 / 删关键词。**绝不改 active**——退订只能由
 *   用户明确发「退订」完成，模型没有这个权力。
 *
 * 失败一律返回 `{ ok: false, failure }` 而不是抛：工具循环里抛异常会中断整轮，
 * 而「仓库不存在」「GitHub 限流」都是要如实告诉用户的正常结果。
 *
 * 这里不 import DB / env：依赖全部由调用方注入，单测与评测都能零依赖跑。
 */

/** 工具内检索条数上限：比交互检索的 25 更小，控制一轮工具调用的输出长度。 */
export const TOOL_MAX_TOP_N = 10;
const DEFAULT_TOP_N = 10;

export type ToolFailure = 'invalid-repo' | 'not-found' | 'rate-limited' | 'missing-term' | 'error';

export interface ToolError {
  ok: false;
  failure: ToolFailure;
  /** 可直接展示给用户的中文说明。 */
  message: string;
}

export interface ToolContext {
  wecomUserid: string;
  now: () => number;
  github: GithubClient;
  search: (query: SearchQuery, wecomUserid: string) => Promise<SearchResultItem[]>;
  getToken: (wecomUserid: string) => Promise<{ token: string | null; source: string }>;
  readSubscription: (wecomUserid: string) => Promise<SubscriptionSnapshot | null>;
  removeTerm: (
    wecomUserid: string,
    term: string,
  ) => Promise<{ removed: boolean; keywords: string[] }>;
}

export interface SearchTrendingArgs {
  keywords?: string[];
  languages?: string[];
  period?: SearchQuery['period'];
  minStars?: number | null;
  sortBy?: SearchQuery['sortBy'];
  topN?: number;
}

export type SearchTrendingResult =
  | { ok: true; query: SearchQuery; items: SearchResultItem[] }
  | ToolError;

export interface RepoArgs {
  repo: string;
}

export type DeepDiveResult =
  | {
      ok: true;
      repo: RepoInfo;
      health: RepoHealth;
      readme: string | null;
      releases: ReleaseInfo[];
      commits: CommitInfo[];
      notes: string[];
    }
  | ToolError;

export type RepoHealthResult =
  | { ok: true; repo: RepoInfo; health: RepoHealth; notes: string[] }
  | ToolError;

export interface ManageSubscriptionArgs {
  action: 'show' | 'remove_term';
  term?: string;
}

export type ManageSubscriptionResult =
  | { ok: true; action: 'show'; summary: string }
  | { ok: true; action: 'remove_term'; term: string; removed: boolean; keywords: string[] }
  | ToolError;

/** 模型给的参数不可信：语言小写、关键词去空白、topN 钳位到 1..10。 */
function toSearchQuery(args: SearchTrendingArgs): SearchQuery {
  const clean = (list: string[] | undefined): string[] =>
    (list ?? []).map((item) => item.trim()).filter(Boolean);
  const rawTopN = args.topN;
  const topN =
    typeof rawTopN === 'number' && Number.isFinite(rawTopN)
      ? Math.min(TOOL_MAX_TOP_N, Math.max(1, Math.round(rawTopN)))
      : DEFAULT_TOP_N;
  const rawMinStars = args.minStars;
  return {
    intent: 'search',
    keywords: clean(args.keywords),
    languages: clean(args.languages).map((item) => item.toLowerCase()),
    period: args.period ?? 'week',
    minStars:
      typeof rawMinStars === 'number' && Number.isFinite(rawMinStars)
        ? Math.max(0, Math.round(rawMinStars))
        : null,
    sortBy: args.sortBy ?? 'stars_delta',
    topN,
  };
}

export async function toolSearchTrending(
  args: SearchTrendingArgs,
  ctx: ToolContext,
): Promise<SearchTrendingResult> {
  const query = toSearchQuery(args);
  try {
    const items = await ctx.search(query, ctx.wecomUserid);
    return { ok: true, query, items };
  } catch (err) {
    console.warn('[tools] search failed:', err instanceof Error ? err.message : err);
    return { ok: false, failure: 'error', message: '检索失败，请稍后再试' };
  }
}

function repoRefOrError(raw: string): { ok: true; ref: { owner: string; name: string } } | ToolError {
  const ref = parseRepoRef(raw);
  if (ref === null) {
    return {
      ok: false,
      failure: 'invalid-repo',
      message: '没认出仓库名，请用 owner/repo 的写法（例如 astral-sh/ruff）',
    };
  }
  return { ok: true, ref };
}

function repoFailure(
  ref: { owner: string; name: string },
  failure: 'not-found' | 'rate-limited' | 'error',
  message: string,
): ToolError {
  const fullName = `${ref.owner}/${ref.name}`;
  if (failure === 'not-found') {
    return { ok: false, failure, message: `没找到这个仓库：${fullName}（检查一下拼写）` };
  }
  if (failure === 'rate-limited') {
    return {
      ok: false,
      failure,
      message: 'GitHub 限流了，稍后再试（发「绑定」后可以用你自己的额度）',
    };
  }
  return { ok: false, failure: 'error', message: `读取 GitHub 失败：${message}` };
}

async function tokenFor(ctx: ToolContext): Promise<string | null> {
  try {
    const resolved = await ctx.getToken(ctx.wecomUserid);
    return resolved.token;
  } catch {
    return null;
  }
}

export async function toolDeepDiveRepo(
  args: RepoArgs,
  ctx: ToolContext,
): Promise<DeepDiveResult> {
  const parsed = repoRefOrError(args.repo);
  if (!parsed.ok) return parsed;
  const { ref } = parsed;
  const token = await tokenFor(ctx);

  try {
    const repoResult = await ctx.github.getRepo(ref, token);
    if (!repoResult.ok) {
      return repoFailure(ref, repoResult.failure, repoResult.message);
    }

    const [readmeResult, releasesResult, commitsResult] = await Promise.all([
      ctx.github.getReadme(ref, token),
      ctx.github.getReleases(ref, token),
      ctx.github.getCommits(ref, token),
    ]);

    const notes: string[] = [];
    const readme = readmeResult.ok ? readmeResult.data : null;
    if (!readmeResult.ok) notes.push('readme 读取失败，本次不提供（不影响其他结论）');

    const releases = releasesResult.ok ? releasesResult.data : [];
    if (!releasesResult.ok) notes.push('最近发布没取到，健康度按「没有发布记录」计算');

    const commits = commitsResult.ok ? commitsResult.data : [];
    if (!commitsResult.ok) notes.push('最近提交没取到，健康度按「没有提交时间」计算');

    const health = computeRepoHealth(repoResult.data, releases, commits, ctx.now());
    return { ok: true, repo: repoResult.data, health, readme, releases, commits, notes };
  } catch (err) {
    console.warn('[tools] deep dive failed:', err instanceof Error ? err.message : err);
    return { ok: false, failure: 'error', message: '读取仓库时出错，请稍后再试' };
  }
}

export async function toolRepoHealth(args: RepoArgs, ctx: ToolContext): Promise<RepoHealthResult> {
  const parsed = repoRefOrError(args.repo);
  if (!parsed.ok) return parsed;
  const { ref } = parsed;
  const token = await tokenFor(ctx);

  try {
    const repoResult = await ctx.github.getRepo(ref, token);
    if (!repoResult.ok) {
      return repoFailure(ref, repoResult.failure, repoResult.message);
    }

    const [releasesResult, commitsResult] = await Promise.all([
      ctx.github.getReleases(ref, token),
      ctx.github.getCommits(ref, token),
    ]);

    const notes: string[] = [];
    const releases = releasesResult.ok ? releasesResult.data : [];
    if (!releasesResult.ok) notes.push('最近发布没取到，健康度按「没有发布记录」计算');
    const commits = commitsResult.ok ? commitsResult.data : [];
    if (!commitsResult.ok) notes.push('最近提交没取到，健康度按「没有提交时间」计算');

    const health = computeRepoHealth(repoResult.data, releases, commits, ctx.now());
    return { ok: true, repo: repoResult.data, health, notes };
  } catch (err) {
    console.warn('[tools] repo health failed:', err instanceof Error ? err.message : err);
    return { ok: false, failure: 'error', message: '读取仓库时出错，请稍后再试' };
  }
}

export async function toolManageSubscription(
  args: ManageSubscriptionArgs,
  ctx: ToolContext,
): Promise<ManageSubscriptionResult> {
  if (args.action === 'show') {
    try {
      const subscription = await ctx.readSubscription(ctx.wecomUserid);
      const summary =
        subscription === null
          ? '你还没有订阅。发「订阅 <偏好>」即可开通每日简报。'
          : formatSubscriptionSummary(subscription.preferences, subscription.active);
      return { ok: true, action: 'show', summary };
    } catch (err) {
      console.warn('[tools] read subscription failed:', err instanceof Error ? err.message : err);
      return { ok: false, failure: 'error', message: '暂时读不到订阅设置，请稍后再试' };
    }
  }

  const term = args.term?.trim() ?? '';
  if (term === '') {
    return {
      ok: false,
      failure: 'missing-term',
      message: '要删哪个关键词？例如：取消订阅 rpa',
    };
  }

  try {
    const result = await ctx.removeTerm(ctx.wecomUserid, term);
    return { ok: true, action: 'remove_term', term, removed: result.removed, keywords: result.keywords };
  } catch (err) {
    console.warn('[tools] remove term failed:', err instanceof Error ? err.message : err);
    return { ok: false, failure: 'error', message: '修改订阅失败，请稍后再试' };
  }
}

/**
 * 交给 AI SDK 的工具定义（模型看到的 schema + 描述）。
 * 描述里刻意写明「什么时候用」，模型选工具靠的就是这几句话。
 */
export function createTools(ctx: ToolContext) {
  return {
    search_trending: tool({
      description:
        '检索 GitHub Trending 榜单。用户要找项目、问「有什么值得看的」，或需要换一组条件时使用。',
      inputSchema: z.object({
        keywords: z.array(z.string()).optional().describe('关键词，如 ["ai", "agent"]'),
        languages: z.array(z.string()).optional().describe('语言，如 ["python"]'),
        period: z.enum(['today', 'week', 'month', 'all']).optional().describe('时间范围，默认 week'),
        minStars: z.number().nullable().optional().describe('最低 star 数'),
        sortBy: z.enum(['stars_delta', 'stars', 'new']).optional().describe('排序依据'),
        topN: z.number().optional().describe(`返回条数，1–${TOOL_MAX_TOP_N}，默认 ${DEFAULT_TOP_N}`),
      }),
      execute: async (args) => toolSearchTrending(args, ctx),
    }),
    deep_dive_repo: tool({
      description:
        '深入了解某个具体仓库：简介、star、readme 摘要、最近发布与提交、健康度。用户点名一个仓库并想「多讲讲」时使用。',
      inputSchema: z.object({
        repo: z.string().describe('owner/repo 或 GitHub 链接，如 astral-sh/ruff'),
      }),
      execute: async (args) => toolDeepDiveRepo(args, ctx),
    }),
    repo_health: tool({
      description:
        '判断一个仓库是否值得用/是否还在维护。用户问「靠不靠谱」「有没有风险」「还在维护吗」时使用。指标由代码计算，你只负责解释。',
      inputSchema: z.object({
        repo: z.string().describe('owner/repo 或 GitHub 链接，如 astral-sh/ruff'),
      }),
      execute: async (args) => toolRepoHealth(args, ctx),
    }),
    manage_subscription: tool({
      description:
        '查看或修改订阅偏好。action=show 看当前设置；action=remove_term 删掉一个偏好关键词。注意：不能开通或退订。',
      inputSchema: z.object({
        action: z.enum(['show', 'remove_term']),
        term: z.string().optional().describe('remove_term 时要删除的关键词'),
      }),
      execute: async (args) => toolManageSubscription(args, ctx),
    }),
  };
}
