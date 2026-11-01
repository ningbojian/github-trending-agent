import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { emailSubscribers, subscribers } from '../db/schema.js';
import { normalizeEmailPreferences } from '../email/preferences.js';
import { normalizePreferences } from './preferences.js';
import { shanghaiToday } from './time.js';

/**
 * 「现在有没有人该收到简报」的轻量检查。
 *
 * cron 每 5 分钟触发一次；没有这个检查时，即使所有人都已发过，端点也会
 * 重建快照（摘要 + 短句要调模型，实测 ~220 秒）并跑观察——纯粹浪费。
 * 这里只做两次 select + 纯计算，命中才进入重活路径。
 *
 * 失败 fail-open（当作有人到点）：宁可多做一次，也不能漏发。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 北京时间当天的分钟数（0–1439）。北京无夏令时，直接 +8h 取 UTC 即可。 */
function beijingMinutes(now: Date): number {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

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

export async function anyDigestDue(now: Date = new Date()): Promise<boolean> {
  const today = shanghaiToday(now);
  const minutes = beijingMinutes(now);
  try {
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
        })
        .from(emailSubscribers)
        .where(eq(emailSubscribers.active, true)),
    ]);

    const wecomDue = wecomRows.some((row) => {
      const prefs = normalizePreferences(row.preferences);
      return (
        minutes >= pushMinutes(prefs.pushTime) &&
        eligible(
          row.lastDigestAt ? new Date(row.lastDigestAt) : null,
          prefs.intervalDays,
          today,
        )
      );
    });
    if (wecomDue) return true;

    return emailRows.some((row) => {
      const prefs = normalizeEmailPreferences(row.preferences);
      return (
        minutes >= pushMinutes(prefs.pushTime) &&
        eligible(
          row.lastSentAt ? new Date(row.lastSentAt) : null,
          prefs.intervalDays,
          today,
        )
      );
    });
  } catch (err) {
    // 查询失败就当作有人到点：多跑一次重活，总比全员漏发好。
    console.warn(
      'anyDigestDue failed, assuming due:',
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}
