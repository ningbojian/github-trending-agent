import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache, subscribers, trackedItems, type TrackedCursor } from '../db/schema.js';
import { createGithubClient, type ReleaseInfo, type RepoInfo } from '../github/client.js';
import { sendWeComNews, sendWeComText } from '../wecom/api.js';
import type { NewsArticle } from '../wecom/news.js';
import { shanghaiToday } from './time.js';
import {
  computeTrackedChanges,
  formatTrackedSummary,
  nextCursor,
  type TrackedChange,
} from './tracking.js';

/**
 * 每日跟踪检查（GitHub 仓库）。
 *
 * - 只检查「20 小时未检查」的 active 项，按用户原子处理：预算不够就整人跳过，
 *   避免「这次查出了变化、却因为预算没发出去」被标记成已检查；
 * - 每人每天最多一条变化摘要（marker 48h），发送前写 marker（at-most-once）；
 * - **cursor 只在发送成功后推进**：发送失败保留旧 cursor，下个 tick 重试；
 * - 不写 push-history：跟踪提醒和简报去重是两件事，混在一起会让仓库从简报里消失。
 */

const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;
const MARKER_PREFIX = 'tracked-notice:v1:';
const MARKER_TTL_MS = 48 * 60 * 60 * 1000;
/**
 * 单个用户的预算估计：同一用户的条目并行检查，最坏是一波 6 秒的请求。
 * 不要按「每条 6 秒」累加——那样跟踪 8–10 个仓库的人会被整人跳过。
 */
const PER_USER_BUDGET_MS = 6_000;

/**
 * 跟踪变化也走卡片：只要推送里带仓库和链接，就用 news（和每日简报同一形态）。
 * 从 `facts` 前缀（owner/repo：...）取仓库名拼 GitHub 链接；取不到就不给链接。
 */
function changesToArticles(changes: TrackedChange[]): NewsArticle[] {
  return changes.slice(0, 8).map((change) => {
    const match = change.facts.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)[：:]/);
    const fullName = match?.[1] ?? '';
    return {
      title: clipBytes(fullName === '' ? '跟踪变化' : `${fullName} 有变化`, 120),
      description: clipBytes(change.facts, 480),
      url:
        fullName === ''
          ? 'https://github.com/trending'
          : `https://github.com/${fullName}`,
    };
  });
}

/** 按字节截断（中文按字符算），补省略号。 */
function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(`${out}${char}`, 'utf8') > max - 3) break;
    out += char;
  }
  return `${out}...`;
}

export interface PushTrackedOptions {
  now?: Date;
  /** 本次检查的时间预算（毫秒），默认 45 秒。 */
  budgetMs?: number;
  clock?: () => number;
}

export interface PushTrackedResult {
  sent: number;
  skipped: number;
  failed: number;
  checked: number;
}

interface DueRow {
  id: number;
  wecomUserid: string;
  identifier: string;
  displayName: string;
  cursor: TrackedCursor;
}

function markerKey(date: string, userid: string): string {
  return `${MARKER_PREFIX}${date}:${userid}`;
}

async function wasNoticeSent(userid: string, date: string, now: Date): Promise<boolean> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(eq(kvCache.key, markerKey(date, userid)));
  const row = rows[0];
  if (!row) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

async function markNoticeSent(userid: string, date: string, now: Date): Promise<void> {
  const expiresAt = new Date(now.getTime() + MARKER_TTL_MS);
  await db()
    .insert(kvCache)
    .values({ key: markerKey(date, userid), value: { sent: true }, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: { sent: true }, expiresAt },
    });
}

/** 检查所有到期的跟踪项；返回计数供 cron 记录。 */
export async function pushTrackedChanges(
  options: PushTrackedOptions = {},
): Promise<PushTrackedResult> {
  const now = options.now ?? new Date();
  const clock = options.clock ?? Date.now;
  const budgetMs = options.budgetMs ?? 45_000;
  const startedAt = clock();

  const result: PushTrackedResult = { sent: 0, skipped: 0, failed: 0, checked: 0 };

  // 未认证的 60 次/小时撑不起批量检查；没有服务端 token 就不查（命令仍可用）。
  if (!env.GITHUB_TOKEN) {
    console.warn('[tracking] GITHUB_TOKEN missing, skip checks');
    return result;
  }

  const cutoff = new Date(now.getTime() - CHECK_INTERVAL_MS);
  const rows = (await db()
    .select({
      id: trackedItems.id,
      wecomUserid: trackedItems.wecomUserid,
      identifier: trackedItems.identifier,
      displayName: trackedItems.displayName,
      cursor: trackedItems.cursor,
    })
    .from(trackedItems)
    .innerJoin(
      subscribers,
      eq(trackedItems.wecomUserid, subscribers.wecomUserid),
    )
    .where(
      and(
        eq(trackedItems.active, true),
        eq(trackedItems.kind, 'repo'),
        eq(subscribers.active, true),
        or(
          isNull(trackedItems.lastCheckedAt),
          lt(trackedItems.lastCheckedAt, cutoff),
        ),
      ),
    )) as DueRow[];

  const byUser = new Map<string, DueRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.wecomUserid) ?? [];
    list.push(row);
    byUser.set(row.wecomUserid, list);
  }

  const date = shanghaiToday(now);
  const client = createGithubClient();
  const token = env.GITHUB_TOKEN;

  for (const [userid, items] of byUser) {
    // 同一用户的条目并行检查，最坏是一波 6 秒；预算不够就整人跳过，
    // 绝不「查一半就标记」。按每条累加会误杀跟踪很多仓库的用户。
    if (clock() - startedAt + PER_USER_BUDGET_MS > budgetMs) {
      result.skipped += 1;
      continue;
    }

    if (await wasNoticeSent(userid, date, now)) {
      result.skipped += 1;
      continue;
    }

    const checked = await Promise.all(
      items.map(async (item) => {
        const [owner, name] = item.identifier.split('/');
        if (!owner || !name) return null;
        const [repoResult, releasesResult] = await Promise.all([
          client.getRepo({ owner, name }, token),
          client.getReleases({ owner, name }, token),
        ]);
        result.checked += 1;
        if (!repoResult.ok) return null;
        const snapshot = {
          repo: repoResult.data,
          releases: releasesResult.ok ? releasesResult.data : [],
        };
        return {
          item,
          snapshot,
          changes: computeTrackedChanges(item.cursor, snapshot, now),
        };
      }),
    );

    const checkedSnapshots = new Map<
      number,
      { repo: RepoInfo; releases: ReleaseInfo[] }
    >();
    const changes: TrackedChange[] = [];
    for (const entry of checked) {
      if (entry === null) continue;
      checkedSnapshots.set(entry.item.id, entry.snapshot);
      changes.push(...entry.changes);
    }

    if (changes.length === 0) {
      // 没有变化：只推进 last_checked_at，cursor 本来就没变。
      for (const item of items) {
        if (!checkedSnapshots.has(item.id)) continue;
        await db()
          .update(trackedItems)
          .set({ lastCheckedAt: now })
          .where(eq(trackedItems.id, item.id));
      }
      result.skipped += 1;
      continue;
    }

    const text = formatTrackedSummary(date, changes);
    if (text === null) {
      result.skipped += 1;
      continue;
    }

    try {
      // 先写 marker（at-most-once）：发送失败宁可丢这一次，也不重复。
      await markNoticeSent(userid, date, now);
      try {
        // 带仓库链接的推送统一用卡片；被拒再退回文本。
        await sendWeComNews(userid, changesToArticles(changes));
      } catch (err) {
        console.warn('tracking news failed, fallback to text:', err);
        await sendWeComText(userid, text);
      }
      for (const item of items) {
        const snapshot = checkedSnapshots.get(item.id);
        if (!snapshot) continue;
        await db()
          .update(trackedItems)
          .set({
            cursor: nextCursor(item.cursor, snapshot, now),
            lastCheckedAt: now,
          })
          .where(eq(trackedItems.id, item.id));
      }
      result.sent += 1;
    } catch (err) {
      console.error(`[tracking] send failed for ${userid}:`, err);
      result.failed += 1;
    }
  }

  return result;
}
