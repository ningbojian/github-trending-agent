import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 推送历史：让「昨天推过的」不再出现在今天，以及判断「静默了几天」。
 *
 * 用户真正的抱怨不是「推得不够多」，而是「连着两三天看到同一批仓库」。
 * 所以按仓库记 7 天窗口——而不是按天记是否发过。
 *
 * 复用 kv_cache（不建表）：迁移 0004 会被 journal 时间戳静默跳过，见
 * docs/deploy.md 第 1 节。读写失败一律降级：读不到 = 当天不去重，
 * 写不进 = 明天可能重复一次，都比让推送挂掉好。
 */

export interface PushHistory {
  items: { fullName: string; at: string }[];
  /** 上次给这个用户发消息的时刻（含静默日）；首日礼包也算。 */
  lastSentAt: string | null;
}

/** 60 天：够覆盖 7 天去重窗口，TTL 到期自然回收。 */
export const PUSH_HISTORY_TTL_MS = 60 * 24 * 3600 * 1000;
/** 最多记 60 个仓库；再多说明筛选门槛该调了，不是该存更多历史。 */
export const PUSH_HISTORY_MAX = 60;
/** 7 天内推过的仓库不再出现。 */
export const DEDUP_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;

function historyKey(userid: string): string {
  return `pushed:${userid}`;
}

function parseHistory(value: unknown): PushHistory | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { items?: unknown; lastSentAt?: unknown };
  if (!Array.isArray(raw.items)) return null;
  const items = raw.items
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const item = entry as { fullName?: unknown; at?: unknown };
      if (typeof item.fullName !== 'string' || typeof item.at !== 'string') return null;
      return { fullName: item.fullName, at: item.at };
    })
    .filter((item): item is { fullName: string; at: string } => item !== null);
  return {
    items,
    lastSentAt: typeof raw.lastSentAt === 'string' ? raw.lastSentAt : null,
  };
}

/** 读不到（无行 / 超期 / 坏值 / DB 出错）一律 null：当天不做去重。 */
export async function readPushHistory(
  userid: string,
  now: Date = new Date(),
): Promise<PushHistory | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, historyKey(userid)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return parseHistory(row.value);
  } catch (err) {
    console.error('[push-history] read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 记下这次发了什么。**总是**刷新 lastSentAt（空列表也刷）：
 * 静默补助需要知道「上次说话是哪天」，否则会天天补一句。
 */
export async function recordPush(
  userid: string,
  fullNames: string[],
  now: Date = new Date(),
): Promise<void> {
  try {
    const previous = await readPushHistory(userid, now);
    const at = now.toISOString();
    const merged = new Map<string, string>();
    for (const fullName of fullNames) merged.set(fullName, at);
    for (const item of previous?.items ?? []) {
      if (!merged.has(item.fullName)) merged.set(item.fullName, item.at);
    }
    const items = [...merged.entries()]
      .map(([fullName, when]) => ({ fullName, at: when }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, PUSH_HISTORY_MAX);

    await db()
      .insert(kvCache)
      .values({
        key: historyKey(userid),
        value: { items, lastSentAt: at },
        expiresAt: new Date(now.getTime() + PUSH_HISTORY_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.error('[push-history] write failed:', err instanceof Error ? err.message : err);
  }
}

/** 这个仓库是否落在 7 天窗口内（第 7 天仍算推过）。 */
export function pushedRecently(
  history: PushHistory | null,
  fullName: string,
  now: Date,
): boolean {
  if (history === null) return false;
  const cutoff = now.getTime() - DEDUP_DAYS * DAY_MS;
  return history.items.some((item) => {
    if (item.fullName !== fullName) return false;
    const at = Date.parse(item.at);
    return Number.isFinite(at) && at >= cutoff;
  });
}
