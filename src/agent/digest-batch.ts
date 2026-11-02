import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { shanghaiToday } from './time.js';

/**
 * 「更多」批次的当日状态：今天已经额外发过几批、发过哪些仓库。
 *
 * 为什么需要：主推送已经把条目写进 7 天历史，但同一批「更多」不能把刚发的
 * 又发一遍——历史是按天窗口，挡不住同一天内的重复。这里按北京日期记一份
 * 当日游标，最多 3 批（news 一条最多 8 篇，3 批 = 24 条，足够覆盖候选池）。
 */
export const MAX_EXTRA_BATCHES = 3;

const TTL_MS = 2 * 24 * 60 * 60 * 1000;

export interface BatchState {
  batches: number;
  shown: string[];
}

function batchKey(wecomUserid: string, date: string): string {
  return `digest-batch:v1:${wecomUserid}:${date}`;
}

function parse(value: unknown): BatchState {
  if (typeof value !== 'object' || value === null) {
    return { batches: 0, shown: [] };
  }
  const raw = value as { batches?: unknown; shown?: unknown };
  return {
    batches:
      typeof raw.batches === 'number' && Number.isFinite(raw.batches)
        ? Math.max(0, Math.trunc(raw.batches))
        : 0,
    shown: Array.isArray(raw.shown)
      ? raw.shown.filter((name): name is string => typeof name === 'string')
      : [],
  };
}

/** 读不到/坏值/DB 异常都返回空状态（fail-open：宁可多发一批，也不少发）。 */
export async function readBatch(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<BatchState> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, batchKey(wecomUserid, shanghaiToday(now))))
      .limit(1);
    const row = rows[0];
    if (!row || row.expiresAt.getTime() <= now.getTime()) {
      return { batches: 0, shown: [] };
    }
    return parse(row.value);
  } catch {
    return { batches: 0, shown: [] };
  }
}

/** 记一批：批次数 +1，并追加本批发出的仓库。 */
export async function recordBatch(
  wecomUserid: string,
  fullNames: string[],
  now: Date = new Date(),
): Promise<BatchState> {
  const previous = await readBatch(wecomUserid, now);
  const next: BatchState = {
    batches: previous.batches + 1,
    shown: [...new Set([...previous.shown, ...fullNames])],
  };
  try {
    const key = batchKey(wecomUserid, shanghaiToday(now));
    await db()
      .insert(kvCache)
      .values({
        key,
        value: next,
        expiresAt: new Date(now.getTime() + TTL_MS),
      })
      .onConflictDoUpdate({ target: kvCache.key, set: { value: next } });
  } catch (err) {
    console.warn(
      'recordBatch failed:',
      err instanceof Error ? err.message : err,
    );
  }
  return next;
}

/**
 * 每周只提示一次「可以回『更多』」——每天提示会变成噪音。
 * 抢不到（已提示过）或存储异常都返回 false（不提示）。
 */
export async function takeMoreHint(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const rows = await db()
      .insert(kvCache)
      .values({
        key: `more-hint:v1:${wecomUserid}`,
        value: { at: now.toISOString() },
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing({ target: kvCache.key })
      .returning({ key: kvCache.key });
    return rows.length > 0;
  } catch {
    return false;
  }
}
