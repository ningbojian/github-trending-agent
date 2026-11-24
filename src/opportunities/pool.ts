import { and, eq, inArray } from 'drizzle-orm';
import { shanghaiToday } from '../agent/time.js';
import {
  loadRepoSummaries,
  type SummaryInput,
} from '../agent/repo-summary.js';
import { db } from '../db/client.js';
import { kvCache, repos, sourceItems } from '../db/schema.js';
import { selectOpportunityItems } from './score.js';
import {
  summarizeOpportunities,
  type OpportunitySummary,
} from './summarize.js';
import type {
  OpportunityItem,
  OpportunityKind,
  OpportunityPool,
  RawOpportunityFact,
} from './types.js';

export type { OpportunityPool } from './types.js';

export const OPPORTUNITY_POOL_PREFIX = 'opportunity-pool:v1:';
const POOL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUILD_LOCK_PREFIX = 'opportunity-build:v1:';
const BUILD_LOCK_TTL_MS = 5 * 60 * 1000;
const BUILD_LOCK_ENABLED = process.env.VITEST !== 'true';

export interface OpportunityBuildDeps {
  readRawFacts?: (date: string) => Promise<RawOpportunityFact[]>;
  summarize?: (
    items: OpportunityItem[],
  ) => Promise<Map<string, OpportunitySummary>>;
  /** 仓库中文简介（卡片第一行）；默认走共享缓存 + 运营方 LLM。 */
  repoSummaries?: (items: SummaryInput[]) => Promise<Map<string, string>>;
  claim?: (date: string) => Promise<boolean>;
  release?: (date: string) => Promise<void>;
  /** 人工抽查/调门槛后强制重建当天池。 */
  force?: boolean;
}

export function poolKey(date: string): string {
  return `${OPPORTUNITY_POOL_PREFIX}${date}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isValidPool(value: unknown, date: string): value is OpportunityPool {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.date === date &&
    typeof value.dataDate === 'string' &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.items)
  );
}

function toFactFromRow(row: {
  sourceId: string;
  title: string;
  url: string;
  description: string | null;
  topics: string[];
  metrics: Record<string, number>;
  raw: unknown;
}): RawOpportunityFact | null {
  if (!isRecord(row.raw)) return null;
  const raw = row.raw;
  const repo = stringOrNull(raw.repo);
  const issueNumber = numberOrZero(raw.issueNumber);
  if (!repo || issueNumber <= 0) return null;
  const kind: OpportunityKind =
    raw.kind === 'research' ? 'research' : 'contribute';
  return {
    id: row.sourceId,
    kind,
    repo,
    repoDescription: stringOrNull(raw.repoDescription),
    issueNumber,
    title: row.title,
    body: row.description ?? '',
    url: row.url,
    language: stringOrNull(raw.language),
    topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
    stars: numberOrZero(row.metrics.stars),
    license: stringOrNull(raw.license),
    archived: raw.archived === true,
    pushedAt: stringOrNull(raw.pushedAt),
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    comments: numberOrZero(row.metrics.comments),
    reactions: numberOrZero(row.metrics.reactions),
    createdAt: stringOrNull(raw.createdAt),
    updatedAt: stringOrNull(raw.updatedAt),
    maintainerEngaged: raw.maintainerEngaged === true,
    assigned: raw.assigned === true,
    linkedPr: raw.linkedPr === true,
  };
}

async function readRawFacts(date: string): Promise<RawOpportunityFact[]> {
  const rows = await db()
    .select({
      sourceId: sourceItems.sourceId,
      title: sourceItems.title,
      url: sourceItems.url,
      description: sourceItems.description,
      topics: sourceItems.topics,
      metrics: sourceItems.metrics,
      raw: sourceItems.raw,
    })
    .from(sourceItems)
    .where(
      and(
        eq(sourceItems.source, 'opportunity'),
        eq(sourceItems.capturedDate, date),
      ),
    );
  return rows.flatMap((row) => {
    const fact = toFactFromRow(row);
    return fact === null ? [] : [fact];
  });
}

async function tryClaimBuild(date: string): Promise<boolean> {
  if (!BUILD_LOCK_ENABLED) return true;
  try {
    const rows = await db()
      .insert(kvCache)
      .values({
        key: `${BUILD_LOCK_PREFIX}${date}`,
        value: { at: new Date().toISOString() },
        expiresAt: new Date(Date.now() + BUILD_LOCK_TTL_MS),
      })
      .onConflictDoNothing({ target: kvCache.key })
      .returning({ key: kvCache.key });
    return rows.length > 0;
  } catch {
    // 抢锁异常按抢到处理（fail-open，宁可重复构建也不缺数据）。
    return true;
  }
}

async function releaseBuildLock(date: string): Promise<void> {
  if (!BUILD_LOCK_ENABLED) return;
  try {
    await db()
      .delete(kvCache)
      .where(eq(kvCache.key, `${BUILD_LOCK_PREFIX}${date}`));
  } catch {
    // 锁会自然过期，释放失败不影响正确性。
  }
}

async function writePool(pool: OpportunityPool, now: Date): Promise<void> {
  const expiresAt = new Date(now.getTime() + POOL_TTL_MS);
  await db()
    .insert(kvCache)
    .values({ key: poolKey(pool.date), value: pool, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: pool, expiresAt },
    });
}

/**
 * 旧池条目没有仓库描述（本字段是后加的）：读池时用 `repos` 表 + `repo-zh`
 * 缓存补一次，让第一行立即有内容，不必等池重建。
 * 新池已经有 repoSummary/repoDescription，直接跳过（零额外查询）。
 */
async function enrichRepoDescriptions(
  pool: OpportunityPool,
): Promise<OpportunityPool> {
  const missing = pool.items.filter(
    (item) => !item.repoSummary && !item.repoDescription,
  );
  if (missing.length === 0) return pool;
  try {
    const names = [...new Set(missing.map((item) => item.repo))];
    const rows = await db()
      .select({ fullName: repos.fullName, description: repos.description })
      .from(repos)
      .where(inArray(repos.fullName, names));
    const descriptions = new Map(
      rows.map((row) => [String(row.fullName), row.description]),
    );
    const summaries = await loadRepoSummaries(
      names.map((name) => ({
        fullName: name,
        description: descriptions.get(name) ?? null,
      })),
      { kind: 'none' },
    );
    return {
      ...pool,
      items: pool.items.map((item) => {
        if (item.repoSummary || item.repoDescription) return item;
        const description = descriptions.get(item.repo);
        const summary = summaries.get(item.repo);
        if (description == null && summary === undefined) return item;
        return {
          ...item,
          ...(description != null ? { repoDescription: description } : {}),
          ...(summary !== undefined ? { repoSummary: summary } : {}),
        };
      }),
    };
  } catch {
    return pool;
  }
}

/** 读指定日期的池；形状不对/过期/查询失败一律 null（调用方降级，不抛）。 */
async function readPoolByDate(
  date: string,
  now: Date,
): Promise<OpportunityPool | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, poolKey(date)));
    const row = rows[0];
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= now.getTime()) return null;
    return isValidPool(row.value, date)
      ? enrichRepoDescriptions(row.value)
      : null;
  } catch {
    return null;
  }
}

/** 读当天池。 */
export async function readOpportunityPool(
  now: Date = new Date(),
): Promise<OpportunityPool | null> {
  return readPoolByDate(shanghaiToday(now), now);
}

/**
 * 读最近的池：GitHub Actions 的每日管线经常晚点/漏跑，邮件 09:00 发信时
 * 当天池可能还没生成。回退到最近 1–2 天的池，避免机会区块直接消失。
 */
export async function readLatestOpportunityPool(
  now: Date = new Date(),
  maxAgeDays = 2,
): Promise<OpportunityPool | null> {
  for (let offset = 0; offset <= maxAgeDays; offset += 1) {
    const date = shanghaiToday(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000));
    const pool = await readPoolByDate(date, now);
    if (pool) return pool;
  }
  return null;
}

/** 仓库简介每批 10 个：与卡片短句同款，避免单次调用过大超时。 */
const REPO_SUMMARY_BATCH = 10;

async function loadRepoSummariesSafe(
  selected: OpportunityItem[],
  loader: (items: SummaryInput[]) => Promise<Map<string, string>>,
): Promise<Map<string, string>> {
  const unique = [...new Map(selected.map((item) => [item.repo, item])).values()];
  const batches: SummaryInput[][] = [];
  for (let start = 0; start < unique.length; start += REPO_SUMMARY_BATCH) {
    batches.push(
      unique.slice(start, start + REPO_SUMMARY_BATCH).map((item) => ({
        fullName: item.repo,
        description: item.repoDescription ?? null,
        topics: item.topics,
      })),
    );
  }
  const merged = new Map<string, string>();
  const results = await Promise.all(
    batches.map(async (batch) => {
      try {
        return await loader(batch);
      } catch (err) {
        console.warn(
          'opportunity repo summaries batch failed (degrade to repo name):',
          err instanceof Error ? err.message : err,
        );
        return new Map<string, string>();
      }
    }),
  );
  for (const result of results) {
    for (const [repo, summary] of result) merged.set(repo, summary);
  }
  return merged;
}

/**
 * 构建当天共享池：读 source_items → 硬门槛/评分 → 一次 LLM 合成 → kv_cache。
 * 仓库简介在机会文案之后生成；单批失败只降级对应条目。
 * 锁冲突/无数据/无合格条目都返回原因，不抛；写库失败才抛（端点记 500）。
 */
export async function buildOpportunityPool(
  now: Date = new Date(),
  deps: OpportunityBuildDeps = {},
): Promise<{ pool: OpportunityPool | null; reason?: string }> {
  const date = shanghaiToday(now);
  const claim = deps.claim ?? tryClaimBuild;
  const release = deps.release ?? releaseBuildLock;

  // Actions 重跑/手动触发时不要重复烧 LLM：当天池已存在直接返回；force=1 跳过。
  if (!deps.force) {
    const existing = await readOpportunityPool(now);
    if (existing) return { pool: existing };
  }

  if (!(await claim(date))) {
    return { pool: null, reason: 'locked' };
  }

  try {
    const facts = await (deps.readRawFacts ?? readRawFacts)(date);
    if (facts.length === 0) {
      return { pool: null, reason: 'no-data' };
    }

    // 邮件每天 2+1、7 天不重复：20+10 给一周多留余量；仍只做一次共享 LLM call。
    const selected = selectOpportunityItems(facts, now.getTime(), {
      contribute: 20,
      research: 10,
    });
    if (selected.length === 0) {
      return { pool: null, reason: 'no-qualified' };
    }

    const repoSummaryLoader =
      deps.repoSummaries ??
      ((inputs: SummaryInput[]) =>
        loadRepoSummaries(inputs, { kind: 'operator' }));

    let summaries: Map<string, OpportunitySummary>;
    try {
      summaries = await (deps.summarize ?? summarizeOpportunities)(
        selected,
      );
    } catch {
      // LLM 不可用：保留 toOpportunityItem 的确定性文案。
      summaries = new Map();
    }
    // 仓库简介单独成批、串行于机会文案：避免同一网关同时接 6 路请求。
    const repoSummaries = await loadRepoSummariesSafe(
      selected,
      repoSummaryLoader,
    );

    const items: OpportunityItem[] = selected.map((item) => {
      const summary = summaries.get(item.id);
      const repoSummary = repoSummaries.get(item.repo);
      const withSummary = summary
        ? {
            ...item,
            short: summary.short,
            why: summary.why,
            firstStep: summary.firstStep,
            effort: summary.effort,
            confidence: summary.confidence,
          }
        : item;
      return repoSummary ? { ...withSummary, repoSummary } : withSummary;
    });

    const pool: OpportunityPool = {
      version: 1,
      date,
      dataDate: date,
      generatedAt: now.toISOString(),
      items,
    };
    await writePool(pool, now);
    return { pool };
  } finally {
    await release(date);
  }
}
