import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { emailSubscribers, kvCache } from '../db/schema.js';
import { shanghaiMinutes, shanghaiToday } from '../agent/time.js';
import {
  getDailySnapshot,
  selectEntriesForPreferences,
  type DigestSnapshot,
} from '../agent/digest-snapshot.js';
import { normalizeEmailPreferences } from './preferences.js';
import { renderDigestEmail } from './render.js';
import { emailConfigured, sendEmail } from './send.js';
import { resolveBaseUrl } from './tokens.js';

/**
 * 邮件简报推送（每小时 cron 调用）。
 * - 全局窗口 09:00–18:00：窗口外直接跳过，不夜间发信。
 * - 每个订阅者：pushTime 整点门控 + intervalDays 间隔门控 + 条件 UPDATE 抢占
 *   （与服务端并发安全，语义同企微 claimDigest）。
 * - 单轮 ≤50 封、发送间隔 ≥250ms、全局日上限 300 封（kv_cache 计数）。
 * - 连续失败 5 次自动停用；失败回滚 lastSentAt 并累加计数。
 * - 快照不可用 → 本轮跳过（邮件没有按用户的降级构建，避免额外模型调用）。
 */

const DEFAULT_GAP_MS = 250;
const DEFAULT_DAILY_CAP = 300;
/** 单轮发送上限：一次函数调用内的耗时/失败面封顶，未发者留给下一个整点。 */
const MAX_PER_RUN = 50;
const MAX_CONSECUTIVE_FAILURES = 5;
const WINDOW_START_MINUTES = 9 * 60;
const WINDOW_END_MINUTES = 18 * 60;
const DAILY_SENT_KEY_PREFIX = 'email_digest_sent:';

export interface PushEmailDigestsResult {
  sent: number;
  skipped: number;
  failed: number;
}

export interface PushEmailOptions {
  now?: Date;
  snapshot?: DigestSnapshot | null;
  gapMs?: number;
  dailyCap?: number;
  /** 站点根地址（cron 无请求头，调用方用 resolveBaseUrl(req.headers) 传入）。 */
  baseUrl?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushTimeMinutes(pushTime: string): number {
  const [hour, minute] = pushTime.split(':');
  return Number(hour) * 60 + Number(minute);
}

function eligible(
  lastSentAt: Date | null,
  intervalDays: number,
  now: Date,
  today: string,
): boolean {
  if (lastSentAt === null) return true;
  if (shanghaiToday(lastSentAt) >= today) return false;
  return lastSentAt.getTime() <= now.getTime() - intervalDays * 86_400_000;
}

async function claim(id: number, intervalDays: number): Promise<boolean> {
  const condition = and(
    eq(emailSubscribers.id, id),
    eq(emailSubscribers.active, true),
    eq(emailSubscribers.confirmed, true),
    or(
      isNull(emailSubscribers.lastSentAt),
      and(
        sql`(${emailSubscribers.lastSentAt} AT TIME ZONE 'Asia/Shanghai')::date < (now() AT TIME ZONE 'Asia/Shanghai')::date`,
        sql`${emailSubscribers.lastSentAt} <= now() - make_interval(days => ${intervalDays})`,
      ),
    ),
  ) as SQL;
  const rows = await db()
    .update(emailSubscribers)
    .set({ lastSentAt: sql`now()` })
    .where(condition)
    .returning({ id: emailSubscribers.id });
  return rows.length > 0;
}

/** 失败/无可发条目：回滚 lastSentAt；失败时累加连续失败计数并在 5 次后停用。 */
async function rollbackClaim(
  id: number,
  previousLastSentAt: Date | null,
  options: { failed: boolean; previousFailures: number },
): Promise<void> {
  try {
    const set: Record<string, unknown> = { lastSentAt: previousLastSentAt };
    if (options.failed) {
      const next = options.previousFailures + 1;
      set.consecutiveFailures = next;
      if (next >= MAX_CONSECUTIVE_FAILURES) set.active = false;
    }
    await db().update(emailSubscribers).set(set).where(eq(emailSubscribers.id, id));
  } catch (err) {
    console.error(`email rollback failed for subscriber ${id}:`, err);
  }
}

async function resetFailures(id: number): Promise<void> {
  try {
    await db()
      .update(emailSubscribers)
      .set({ consecutiveFailures: 0 })
      .where(eq(emailSubscribers.id, id));
  } catch (err) {
    console.error(`email failure reset failed for subscriber ${id}:`, err);
  }
}

async function readDailySent(date: string): Promise<number> {
  const key = `${DAILY_SENT_KEY_PREFIX}${date}`;
  const rows = await db().select().from(kvCache).where(eq(kvCache.key, key));
  const row = rows[0];
  if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return 0;
  return Number((row.value as { count?: unknown }).count ?? 0);
}

async function bumpDailySent(date: string): Promise<void> {
  const key = `${DAILY_SENT_KEY_PREFIX}${date}`;
  try {
    const rows = await db().select().from(kvCache).where(eq(kvCache.key, key));
    const row = rows[0];
    const current =
      row && new Date(row.expiresAt).getTime() > Date.now()
        ? Number((row.value as { count?: unknown }).count ?? 0)
        : 0;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const value = { count: current + 1 };
    await db()
      .insert(kvCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
  } catch (err) {
    console.error('email daily sent counter update failed:', err);
  }
}

/** 向所有已确认的活跃邮箱订阅者推送简报（不截断）。 */
export async function pushEmailDigests(
  options: PushEmailOptions = {},
): Promise<PushEmailDigestsResult> {
  const now = options.now ?? new Date();
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
  const dailyCap = options.dailyCap ?? DEFAULT_DAILY_CAP;

  if (!emailConfigured()) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const rows = await db()
    .select()
    .from(emailSubscribers)
    .where(and(eq(emailSubscribers.active, true), eq(emailSubscribers.confirmed, true)));

  const nowMinutes = shanghaiMinutes(now);
  if (nowMinutes < WINDOW_START_MINUTES || nowMinutes >= WINDOW_END_MINUTES) {
    return { sent: 0, skipped: rows.length, failed: 0 };
  }

  const snapshot =
    options.snapshot !== undefined ? options.snapshot : await getDailySnapshot(now);
  if (!snapshot) {
    console.warn('email push skipped: daily snapshot unavailable');
    return { sent: 0, skipped: rows.length, failed: 0 };
  }

  const today = shanghaiToday(now);
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  const unsubscribeUrl = `${baseUrl}/api/email-unsubscribe?t=`;
  let remaining = Math.max(0, dailyCap - (await readDailySent(today)));
  let runRemaining = MAX_PER_RUN;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (remaining <= 0 || runRemaining <= 0) {
      skipped += 1;
      continue;
    }
    const preferences = normalizeEmailPreferences(row.preferences);
    if (nowMinutes < pushTimeMinutes(preferences.pushTime)) {
      skipped += 1;
      continue;
    }
    if (!eligible(row.lastSentAt ?? null, preferences.intervalDays, now, today)) {
      skipped += 1;
      continue;
    }

    let claimed = false;
    try {
      claimed = await claim(row.id, preferences.intervalDays);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      const items = selectEntriesForPreferences(
        snapshot.items,
        preferences,
        preferences.digestCount,
      );
      if (items.length === 0) {
        await rollbackClaim(row.id, row.lastSentAt ?? null, {
          failed: false,
          previousFailures: row.consecutiveFailures,
        });
        skipped += 1;
        continue;
      }
      const rendered = renderDigestEmail({
        date: snapshot.date,
        pushTime: preferences.pushTime,
        abstract: snapshot.abstract,
        items,
        baseUrl,
        unsubToken: row.unsubToken,
      });
      await sendEmail({
        to: row.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}${encodeURIComponent(row.unsubToken)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      sent += 1;
      remaining -= 1;
      runRemaining -= 1;
      await bumpDailySent(today);
      if (row.consecutiveFailures !== 0) {
        await resetFailures(row.id);
      }
    } catch (err) {
      failed += 1;
      console.error(`email push failed for subscriber ${row.id}:`, err);
      if (claimed) {
        await rollbackClaim(row.id, row.lastSentAt ?? null, {
          failed: true,
          previousFailures: row.consecutiveFailures,
        });
      }
    }
    if (gapMs > 0) {
      await sleep(gapMs);
    }
  }

  return { sent, skipped, failed };
}
