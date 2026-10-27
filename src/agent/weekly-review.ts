import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { favorites, kvCache, subscribers } from '../db/schema.js';
import { readPushHistory, type PushHistory } from './push-history.js';
import { readFeedback, feedbackWeights, type FeedbackEvent } from './taste.js';
import { shanghaiHHMM, shanghaiToday } from './time.js';
import { sendWeComText } from '../wecom/api.js';
import { suggestProfileFromWeek } from '../wecom/pending.js';

/**
 * 每周复盘：把「这周推了什么、你做了什么」说清楚，并给出下周的方向。
 *
 * 为什么放在主动推送里：Agent 感不是「会调用工具」，而是「记得你上周干了什么，
 * 并且下周因此改变」。但它必须是低频、可预期、可关掉的——每周一次、只发给
 * 这周有动静的人；零推送零反馈的账号不发，复盘不能变成新的噪音。
 *
 * 指标全部由代码算，不调模型：数字错了比话说得不好听更糟。
 * 调口味的方式也只写真实存在的命令（订阅/取消订阅），不承诺「回一个字确认」——
 * 那需要多轮状态，Phase 4 才落地，先不画饼。
 *
 * 复用 kv_cache 记「本周已发」（`weekly:v1:<userid>:<YYYYMMDD>`，TTL 8 天）。
 */

/** 一周 7 天窗口。 */
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** 标记 8 天：覆盖一周，又不会拖到下下周。 */
export const WEEKLY_MARKER_TTL_MS = 8 * 24 * 3600 * 1000;
/** 周一 10:00（北京时间）之后的第一班 cron 发；之后每小时都幂等跳过。 */
export const WEEKLY_REVIEW_HOUR = 10;

export interface WeeklyStats {
  /** 这周推送的条目数（来自 push history 的 7 天窗口）。 */
  pushed: number;
  /** 这周新增收藏数。 */
  favorited: number;
  liked: number;
  disliked: number;
  /** 下周该多推的方向（净正的语言/话题）。 */
  more: string[];
  /** 下周该少推的方向（净负的语言/话题）。 */
  less: string[];
}

interface WeekInput {
  history: PushHistory | null;
  favoriteCount: number;
  events: FeedbackEvent[];
}

/** 纯函数：只认 7 天窗口内的事件与推送。 */
export function summarizeWeek(input: WeekInput, now: Date): WeeklyStats {
  const cutoff = now.getTime() - WEEK_MS;
  const inWindow = (at: string): boolean => {
    const time = Date.parse(at);
    return Number.isFinite(time) && time >= cutoff;
  };

  const pushed = (input.history?.items ?? []).filter((item) => inWindow(item.at)).length;
  const events = input.events.filter((event) => inWindow(event.at));
  const liked = events.filter((event) => event.kind === 'like').length;
  const disliked = events.filter((event) => event.kind === 'dislike').length;

  const weights = feedbackWeights(events);
  const ranked = (map: Map<string, number>, positive: boolean): string[] =>
    [...map.entries()]
      .filter(([, weight]) => (positive ? weight > 0 : weight < 0))
      .sort((a, b) => (positive ? b[1] - a[1] : a[1] - b[1]) || a[0].localeCompare(b[0]))
      .map(([name]) => name)
      .slice(0, 2);

  return {
    pushed,
    favorited: input.favoriteCount,
    liked,
    disliked,
    more: [...ranked(weights.languages, true), ...ranked(weights.topics, true)].slice(0, 2),
    less: [...ranked(weights.languages, false), ...ranked(weights.topics, false)].slice(0, 2),
  };
}

/** 一周零推送、零收藏、零反馈 → 不发。 */
export function shouldSendRecap(stats: WeeklyStats): boolean {
  return stats.pushed > 0 || stats.favorited > 0 || stats.liked > 0 || stats.disliked > 0;
}

/** 北京时间周一且已过 10 点。 */
export function isWeeklyReviewSlot(now: Date): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(now);
  if (weekday !== 'Mon') return false;
  const hour = Number(shanghaiHHMM(now).slice(0, 2));
  return hour >= WEEKLY_REVIEW_HOUR;
}

export function weeklyReviewText(stats: WeeklyStats, now: Date): string {
  const lines = ['📊 本周小结'];
  const activity: string[] = [];
  if (stats.pushed > 0) activity.push(`收到 ${stats.pushed} 条推送`);
  if (stats.favorited > 0) activity.push(`收藏 ${stats.favorited} 个`);
  if (activity.length > 0) lines.push(`· ${activity.join('，')}`);
  if (stats.liked + stats.disliked > 0) {
    lines.push(`· 口味反馈：${stats.liked} 次感兴趣，${stats.disliked} 次不感兴趣`);
  }
  if (stats.more.length > 0) lines.push(`· 下周多推：${stats.more.join('、')}`);
  if (stats.less.length > 0) lines.push(`· 下周少推：${stats.less.join('、')}`);
  lines.push('想调整：回「订阅 <关键词>」或「取消订阅 <关键词>」。');
  void now;
  return lines.join('\n');
}

/** 读这周的数据。任何一块失败都降级为 0 / 空，复盘不能因为统计失败而不发。 */
export async function readWeekStats(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<WeeklyStats> {
  const cutoff = new Date(now.getTime() - WEEK_MS);
  const [history, events, favoriteRows] = await Promise.all([
    readPushHistory(wecomUserid, now).catch(() => null),
    readFeedback(wecomUserid, now).catch(() => []),
    db()
      .select({ id: favorites.id })
      .from(favorites)
      .where(and(eq(favorites.wecomUserid, wecomUserid), gte(favorites.createdAt, cutoff)))
      .catch((err: unknown) => {
        console.error('[weekly] favorites read failed:', err instanceof Error ? err.message : err);
        return [];
      }),
  ]);
  return summarizeWeek({ history, favoriteCount: favoriteRows.length, events }, now);
}

function markerKey(wecomUserid: string, week: string): string {
  return `weekly:v1:${wecomUserid}:${week}`;
}

function weekKey(now: Date): string {
  return shanghaiToday(now).replace(/-/g, '');
}

async function listActiveUsers(): Promise<string[]> {
  const rows = await db()
    .select({ wecomUserid: subscribers.wecomUserid })
    .from(subscribers)
    .where(eq(subscribers.active, true));
  return rows.map((row) => row.wecomUserid);
}

async function alreadySent(wecomUserid: string, week: string, now: Date): Promise<boolean> {
  try {
    const rows = await db()
      .select({ expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, markerKey(wecomUserid, week)))
      .limit(1);
    const row = rows[0];
    return row !== undefined && row.expiresAt.getTime() > now.getTime();
  } catch (err) {
    // 读不到标记按「已发」处理：宁可这周漏一次，也不要重复打扰。
    console.error('[weekly] marker read failed:', err instanceof Error ? err.message : err);
    return true;
  }
}

async function markSent(wecomUserid: string, week: string, now: Date): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: markerKey(wecomUserid, week),
        value: { at: now.toISOString() },
        expiresAt: new Date(now.getTime() + WEEKLY_MARKER_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.error('[weekly] marker write failed:', err instanceof Error ? err.message : err);
  }
}

export interface WeeklyReviewOptions {
  now?: Date;
  listUsers?: () => Promise<string[]>;
  loadStats?: (wecomUserid: string, now: Date) => Promise<WeeklyStats>;
  alreadySent?: (wecomUserid: string, week: string, now: Date) => Promise<boolean>;
  markSent?: (wecomUserid: string, week: string, now: Date) => Promise<void>;
  send?: (wecomUserid: string, text: string) => Promise<void>;
  /** 复盘后的一条偏好建议（写入 pending，等用户回「对」）。失败不影响复盘。 */
  suggest?: (wecomUserid: string, stats: WeeklyStats, now: Date) => Promise<void>;
}

export interface WeeklyReviewResult {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * 每周投递入口：由现有 cron 每小时调用，自身按窗口与标记幂等。
 * 单人失败隔离——一个人的 400 不该让后面的人这周收不到复盘。
 */
export async function pushWeeklyReviews(
  options: WeeklyReviewOptions = {},
): Promise<WeeklyReviewResult> {
  const now = options.now ?? new Date();
  if (!isWeeklyReviewSlot(now)) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const week = weekKey(now);
  const listUsers = options.listUsers ?? listActiveUsers;
  const loadStats = options.loadStats ?? readWeekStats;
  const sentAlready = options.alreadySent ?? alreadySent;
  const mark = options.markSent ?? markSent;
  const send = options.send ?? sendWeComText;
  const suggest = options.suggest ?? suggestProfileFromWeek;

  let users: string[];
  try {
    users = await listUsers();
  } catch (err) {
    console.error('[weekly] list users failed:', err instanceof Error ? err.message : err);
    return { sent: 0, skipped: 0, failed: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const userid of users) {
    try {
      if (await sentAlready(userid, week, now)) {
        skipped += 1;
        continue;
      }
      const stats = await loadStats(userid, now);
      if (!shouldSendRecap(stats)) {
        skipped += 1;
        continue;
      }
      await send(userid, weeklyReviewText(stats, now));
      await mark(userid, week, now);
      sent += 1;
      // 复盘已经送达，建议是锦上添花：它失败不能把这个人算成 failed。
      try {
        await suggest(userid, stats, now);
      } catch (err) {
        console.error('[weekly] suggest failed:', err instanceof Error ? err.message : err);
      }
    } catch (err) {
      failed += 1;
      console.error('[weekly] send failed:', err instanceof Error ? err.message : err);
    }
  }
  return { sent, skipped, failed };
}
