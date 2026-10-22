import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { repos } from '../db/schema';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** 限流指数退避：单个仓库最多 3 次尝试（初始 + 2 次重试）。 */
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

/** GET /repos/{owner}/{repo} 响应中我们关心的字段。 */
interface GitHubRepo {
  topics?: string[];
  description: string | null;
  language: string | null;
  stargazers_count: number;
}

type FetchOutcome =
  | { kind: 'ok'; repo: GitHubRepo }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'failed'; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 限流判定：403/429 且 x-ratelimit-remaining 为 0。 */
function isRateLimited(response: Response): boolean {
  return (
    (response.status === 403 || response.status === 429) &&
    response.headers.get('x-ratelimit-remaining') === '0'
  );
}

/**
 * 拉取单个仓库元数据。404 返回 not-found（调用方静默跳过）；
 * 限流按指数退避重试，耗尽 MAX_ATTEMPTS 后返回 rate-limited。
 */
async function fetchRepo(
  owner: string,
  name: string,
  token: string,
): Promise<FetchOutcome> {
  const url = `${API_BASE}/repos/${owner}/${name}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      return { kind: 'failed', reason: (error as Error).message };
    }

    if (response.status === 404) return { kind: 'not-found' };
    if (isRateLimited(response)) {
      if (attempt >= MAX_ATTEMPTS) return { kind: 'rate-limited' };
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }
    if (!response.ok) {
      return { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    try {
      return { kind: 'ok', repo: (await response.json()) as GitHubRepo };
    } catch {
      return { kind: 'failed', reason: 'invalid JSON' };
    }
  }
  // 循环内必然 return；此处仅为满足类型检查。
  return { kind: 'rate-limited' };
}

/**
 * 对 fullNames 对应的 repos 行中 topics 为空的仓库逐个调 GitHub REST API，
 * 补全 topics/description/language/stars——但只写回当前为空的字段，
 * 绝不覆盖 trending 页已抓取的非空值。
 *
 * 404 静默跳过；403/429 限流按指数退避最多重试 3 次，
 * 耗尽后 console.warn 并停止，返回已补全条数（不抛异常）。
 *
 * 返回值：实际写库补全的仓库数。
 */
export async function enrichMissingTopics(
  fullNames: string[],
  token: string,
): Promise<number> {
  if (fullNames.length === 0) return 0;

  const database = db();
  const rows = await database
    .select()
    .from(repos)
    .where(inArray(repos.fullName, fullNames));
  // 只处理 topics 为空（空数组或 null）的仓库；已补全过的直接跳过，省 API 配额。
  const targets = rows.filter((row) => !row.topics || row.topics.length === 0);

  let processed = 0;
  for (const row of targets) {
    const outcome = await fetchRepo(row.owner, row.name, token);

    if (outcome.kind === 'not-found') continue; // 仓库已删/改名，静默跳过
    if (outcome.kind === 'rate-limited') {
      console.warn(
        `[enrich] GitHub API rate limit exhausted after ${MAX_ATTEMPTS} attempts (${row.fullName}); stopping enrichment (processed=${processed})`,
      );
      break;
    }
    if (outcome.kind === 'failed') {
      console.warn(
        `[enrich] fetch ${row.fullName} failed (${outcome.reason}), skip`,
      );
      continue;
    }

    // 只填空字段：页面抓到的非空值优先，API 仅兜底。
    const update: Partial<typeof repos.$inferInsert> = {};
    if (outcome.repo.topics?.length) update.topics = outcome.repo.topics;
    if (!row.description && outcome.repo.description) {
      update.description = outcome.repo.description;
    }
    if (!row.language && outcome.repo.language) {
      update.language = outcome.repo.language;
    }
    if (!row.stars && outcome.repo.stargazers_count > 0) {
      update.stars = outcome.repo.stargazers_count;
    }
    if (Object.keys(update).length === 0) continue;

    await database
      .update(repos)
      .set(update)
      .where(eq(repos.fullName, row.fullName));
    processed += 1;
  }

  return processed;
}
