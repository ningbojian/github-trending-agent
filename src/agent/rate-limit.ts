import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { shanghaiToday } from './time.js';

/**
 * 按用户限流。
 *
 * 为什么需要：全仓此前**没有任何**按用户的速率限制——只有 GitHub API 的
 * `retry-after` 退避。用户配了自己的 Key 后，一个循环发消息的脚本就能无限
 * 烧他自己的额度。运营方负责的推送路径是安全的（走全局共享快照），但互动
 * 路径没有护栏。
 *
 * 为什么放 kv_cache 而不是引入 Redis：这里每请求读一次、写两次，Neon 一次
 * 往返几毫秒；瓶颈在 LLM（数秒）。为一个计数器加常驻服务不划算。什么时候
 * 该换：当一次请求要读多次配额，或需要跨地域亚毫秒一致性时。
 *
 * 为什么强调原子：现有的 `takeConfirmSlot`（`api/subscribe.ts`）与
 * `bumpDailySent`（`src/email/push.ts`）都是 select→加一→upsert，并发下会
 * 超发。限流件如果超发就失去意义，所以这里用 `ON CONFLICT DO UPDATE` 在
 * 一条语句里完成「读旧值 + 加一 + 写回」，由数据库保证原子性。
 */

/** 每分钟最多几条互动消息。够正常聊天，挡得住脚本。 */
export const PER_MINUTE_MESSAGE_LIMIT = 20;
/** 每天最多几条互动消息。 */
export const DAILY_MESSAGE_LIMIT = 200;

/** 桶过期时间：比窗口宽一倍即可，过期的桶自然被忽略。 */
const MINUTE_BUCKET_TTL_MS = 120_000;
const DAY_BUCKET_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** 超限时回给用户的固定文案（纯文本单行，个人微信不渲染 markdown）。 */
export const RATE_LIMIT_REPLY =
  '⏳ 消息太频繁，休息一下再发。冷却后自动恢复，不用重新订阅。';

export type QuotaReason = 'minute' | 'day';

export interface QuotaDecision {
  allowed: boolean;
  /** 拒绝原因；放行时为 null。 */
  reason: QuotaReason | null;
  /** 还要等多少秒（放行时为 0）。 */
  retryAfterSeconds: number;
}

/** 计数存储的抽象：单测注入内存实现，生产用 kv_cache。 */
export interface QuotaStore {
  /** 原子地把 key 加一并返回新值。 */
  increment(key: string, ttlMs: number): Promise<number>;
}

const shanghaiMinuteFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 分钟桶键：`YYYYMMDDHHmm`（北京时间），与 `shanghaiToday` 同一时区口径。 */
export function minuteBucket(now: Date): string {
  const parts = shanghaiMinuteFormatter.formatToParts(now);
  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}${pick('month')}${pick('day')}${pick('hour')}${pick('minute')}`;
}

/** 日键：北京日期 `YYYYMMDD`。复用 `shanghaiToday`，避免第二套时区逻辑。 */
export function shanghaiDayKey(now: Date): string {
  return shanghaiToday(now).replace(/-/g, '');
}

const minuteKey = (userid: string, now: Date): string =>
  `rl:v1:min:${userid}:${minuteBucket(now)}`;
const dayKey = (userid: string, now: Date): string =>
  `rl:v1:day:${userid}:${shanghaiDayKey(now)}`;

/**
 * kv_cache 上的原子累加。
 *
 * `ON CONFLICT DO UPDATE SET value = (value->>'count')::int + 1` 在一条语句里
 * 完成读改写，两个并发请求不会读到同一个旧值。`expires_at` 每次都顺延到
 * 当前窗口末尾——桶本身不重置计数，换桶靠换 key。
 */
export const kvQuotaStore: QuotaStore = {
  async increment(key: string, ttlMs: number): Promise<number> {
    const rows = await db()
      .insert(kvCache)
      .values({
        key,
        value: { count: 1 },
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: {
          value: sql`jsonb_build_object('count', (${kvCache.value}->>'count')::int + 1)`,
          expiresAt: sql`now() + make_interval(secs => ${Math.round(ttlMs / 1000)})`,
        },
      })
      .returning({ value: kvCache.value });
    const value = rows[0]?.value;
    const count =
      typeof value === 'object' && value !== null
        ? Number((value as { count?: unknown }).count)
        : Number.NaN;
    // 返回 0 会让调用方当作「还没用」——宁可报一个大数（触发限流），
    // 也不要因为解析失败而放行无限流量。
    return Number.isFinite(count) ? count : Number.MAX_SAFE_INTEGER;
  },
};

/** 本分钟还剩多少秒（60 表示刚进入新的一分钟）。 */
function secondsLeftInMinute(now: Date): number {
  return 60 - now.getUTCSeconds();
}

/** 距北京次日 00:00 还有多少秒。 */
function secondsLeftInDay(now: Date): number {
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const tomorrowUtc = Date.UTC(
    beijingNow.getUTCFullYear(),
    beijingNow.getUTCMonth(),
    beijingNow.getUTCDate() + 1,
  );
  const tomorrowBeijing = tomorrowUtc - 8 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((tomorrowBeijing - now.getTime()) / 1000));
}

/**
 * 判断这条消息该不该放行。
 *
 * 顺序很重要：**先过分钟桶，再累加日计数**。日上限是「预算」，被分钟桶挡住的
 * 请求不应该消耗它——否则用户撞了一次分钟限流，重试几次就把当天的额度也烧光，
 * 越试越糟。
 *
 * 日计数是一次原子累加后看结果：超出说明已经越界，多记一次无害（它本来就
 * 已经不可用了）；而在上面那步之前就返回的请求，日计数一次都不会动。
 */
export async function checkQuota(
  wecomUserid: string,
  now: Date = new Date(),
  store: QuotaStore = kvQuotaStore,
): Promise<QuotaDecision> {
  try {
    const minuteCount = await store.increment(
      minuteKey(wecomUserid, now),
      MINUTE_BUCKET_TTL_MS,
    );
    if (minuteCount > PER_MINUTE_MESSAGE_LIMIT) {
      return {
        allowed: false,
        reason: 'minute',
        retryAfterSeconds: secondsLeftInMinute(now),
      };
    }

    const total = await store.increment(dayKey(wecomUserid, now), DAY_BUCKET_TTL_MS);
    if (total > DAILY_MESSAGE_LIMIT) {
      return {
        allowed: false,
        reason: 'day',
        retryAfterSeconds: secondsLeftInDay(now),
      };
    }

    return { allowed: true, reason: null, retryAfterSeconds: 0 };
  } catch (err) {
    // fail-open：限流是保护措施，不是业务前提。存储挂了就放行——
    // 否则一次缓存故障会变成「全员不能说话」。
    console.error(
      '[rate-limit] check failed, allowing:',
      err instanceof Error ? err.message : err,
    );
    return { allowed: true, reason: null, retryAfterSeconds: 0 };
  }
}
