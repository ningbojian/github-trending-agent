import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { emailSubscribers, subscribers } from '../db/schema.js';
import {
  EMAIL_WINDOW_END_MINUTES,
  EMAIL_WINDOW_START_MINUTES,
  normalizeEmailPreferences,
} from '../email/preferences.js';
import { normalizePreferences } from './preferences.js';
import { shanghaiMinutes, shanghaiToday } from './time.js';

/**
 * 「现在有没有人该收到简报」的轻量检查。
 *
 * cron 每 30 分钟触发一次；没有这个检查时，即使所有人都已发过，端点也会
 * 重建快照（摘要 + 短句要调模型，实测 ~220 秒）并跑观察——纯粹浪费。
 * 这里只做两次 select + 纯计算，命中才进入重活路径。
 *
 * 失败 fail-open（当作有人到点）：宁可多做一次，也不能漏发。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;

export interface DueWindow {
  /** 北京时间分钟数，包含。 */
  start: number;
  /** 北京时间分钟数，不包含。 */
  end: number;
}

export interface DueSnapshot {
  /** 现在是否真的有人到点（精确判断，与旧 anyDigestDue 同语义）。 */
  dueNow: boolean;
  /** 今天所有「可能到点」的窗口，保守超集，供缓存做预过滤。 */
  windows: DueWindow[];
}

/** 北京时间当天的分钟数（0–1439）。 */
function pushMinutes(pushTime: string): number {
  const [hour, minute] = pushTime.split(':');
  return Number(hour) * 60 + Number(minute);
}

/** 与 pushDigests 的门控同语义：按北京日历日比较，间隔天数 ≥ intervalDays。 */
function eligible(last: Date | null, intervalDays: number, today: string): boolean {
  if (last === null) return true;
  const lastDay = new Date(last.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (lastDay >= today) return false;
  return (Date.parse(today) - Date.parse(lastDay)) / DAY_MS >= intervalDays;
}

function mergeWindows(windows: DueWindow[]): DueWindow[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DueWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * 一次查询同时给出「现在是否真的到点」和「今天所有可能到点的窗口」。
 *
 * 窗口是保守超集，只用于 cron 的前置过滤：不在窗口里就一定没人到点，
 * 在窗口里仍要用 dueNow（或再查一次库）做最终裁决。
 */
export async function readDueSnapshot(
  now: Date = new Date(),
): Promise<DueSnapshot> {
  const today = shanghaiToday(now);
  const minutes = shanghaiMinutes(now);
  const [wecomRows, emailRows] = await Promise.all([
    db()
      .select({
        preferences: subscribers.preferences,
        lastDigestAt: subscribers.lastDigestAt,
      })
      .from(subscribers)
      .where(eq(subscribers.active, true)),
    db()
      .select({
        preferences: emailSubscribers.preferences,
        lastSentAt: emailSubscribers.lastSentAt,
        confirmed: emailSubscribers.confirmed,
      })
      .from(emailSubscribers)
      .where(
        and(
          eq(emailSubscribers.active, true),
          eq(emailSubscribers.confirmed, true),
        ),
      ),
  ]);

  const windows: DueWindow[] = [];
  let dueNow = false;

  for (const row of wecomRows) {
    const prefs = normalizePreferences(row.preferences);
    const start = pushMinutes(prefs.pushTime);
    const eligibleNow = eligible(
      row.lastDigestAt ? new Date(row.lastDigestAt) : null,
      prefs.intervalDays,
      today,
    );
    if (!eligibleNow) continue;
    windows.push({ start, end: DAY_MINUTES });
    if (minutes >= start) dueNow = true;
  }

  for (const row of emailRows) {
    // 未确认的邮箱永远不会被 pushEmailDigests 选中；不能再让它把 due 拉成 true。
    if (row.confirmed !== true) continue;
    const prefs = normalizeEmailPreferences(row.preferences);
    const start = Math.max(
      pushMinutes(prefs.pushTime),
      EMAIL_WINDOW_START_MINUTES,
    );
    const eligibleNow = eligible(
      row.lastSentAt ? new Date(row.lastSentAt) : null,
      prefs.intervalDays,
      today,
    );
    if (!eligibleNow) continue;
    windows.push({ start, end: EMAIL_WINDOW_END_MINUTES });
    // 与 pushEmailDigests 的发送窗口一致：18:00 之后邮件不会再发，due 也不该为真。
    if (
      minutes >= EMAIL_WINDOW_START_MINUTES &&
      minutes < EMAIL_WINDOW_END_MINUTES &&
      minutes >= start
    ) {
      dueNow = true;
    }
  }

  return { dueNow, windows: mergeWindows(windows) };
}

export async function anyDigestDue(now: Date = new Date()): Promise<boolean> {
  try {
    return (await readDueSnapshot(now)).dueNow;
  } catch (err) {
    // 查询失败就当作有人到点：多跑一次重活，总比全员漏发好。
    console.warn(
      'anyDigestDue failed, assuming due:',
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}
