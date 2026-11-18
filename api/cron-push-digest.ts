import { eq } from 'drizzle-orm';
import { cronGates } from '../src/agent/cron-gates.js';
import { PUSH_BUDGET_MS, pushDigests } from '../src/agent/digest.js';
import { probeDue, refreshDueState } from '../src/agent/due-state-cache.js';
import { getDailySnapshot } from '../src/agent/digest-snapshot.js';
import { getDailyObservations } from '../src/agent/observation.js';
import { pushTrackedChanges } from '../src/agent/tracking-check.js';
import { pushWeeklyReviews } from '../src/agent/weekly-review.js';
import { pushEmailDigests } from '../src/email/push.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { getWeComMemberCount } from '../src/wecom/capacity.js';
import { env } from '../src/config.js';
import { db } from '../src/db/client.js';
import { kvCache } from '../src/db/schema.js';

/**
 * 定时推送每日简报端点（Vercel Node function）。
 * - 校验 `Authorization: Bearer <CRON_SECRET>`：缺失/错误 → 401 JSON，不做任何推送
 * - 校验通过 → pushDigests() → 200 JSON `{ sent, skipped, failed }`
 *   （skipped=推送时间未到/当日已发/未满间隔/抢占落败；failed=已抢占但发送失败，
 *   last_digest_at 已回滚，下一小时 tick 自动重试）
 * 请求/响应最小形态与 api/wecom-callback.ts 保持一致（不引入 @vercel/node 依赖）。
 */

/** Vercel Node 函数时长上限（秒）：串行 LLM 简报可能超过默认上限，经 export 生效（无需 vercel.json）。 */
export const maxDuration = 300;

/** Vercel req 的最小形态。 */
export interface CronRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Vercel res 的最小形态。 */
export interface CronResponse {
  status(code: number): CronResponse;
  setHeader(name: string, value: string): CronResponse | void;
  send(body: string): unknown;
}

/** 取 header 首个字符串值（Vercel headers 值可能是 string | string[]）。 */
function header(req: CronRequest, name: string): string {
  const value = req.headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function sendJson(res: CronResponse, status: number, body: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body));
}

/**
 * 心跳：每次触发都往 `cron:last-run:v1` 里追加一条（保留最近 20 次，3 天 TTL）。
 * 排障用——「今天为什么没收到推送」时先看它：有没有触发、每次算出了什么。
 * 失败静默：心跳不能影响推送本身。
 */
async function recordHeartbeat(entry: Record<string, unknown>): Promise<void> {
  try {
    const key = 'cron:last-run:v1';
    const rows = await db()
      .select({ value: kvCache.value })
      .from(kvCache)
      .where(eq(kvCache.key, key));
    const prev = rows[0]?.value as { runs?: unknown[] } | undefined;
    const runs = Array.isArray(prev?.runs) ? prev.runs : [];
    const value = { runs: [entry, ...runs].slice(0, 20) };
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await db()
      .insert(kvCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
  } catch (err) {
    console.warn('cron heartbeat failed:', err);
  }
}

export default async function handler(
  req: CronRequest,
  res: CronResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const expected = `Bearer ${env.CRON_SECRET}`;
  if (header(req, 'authorization') !== expected) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const startedAt = Date.now();
  try {
    const now = new Date();
    // 缓存预过滤：命中且不在 due 窗口时 probeDue 本身不查库；
    // 下面的早退再跳过 tracking/weekly/heartbeat 这些额外查库。
    const probe = await probeDue(now);
    const due = probe.due;
    // 30 分钟 tick 下的围栏：tracking / weekly / heartbeat 不再每个 tick 都跑。
    const gates = cronGates(now, due);
    // 心跳只在本次已经查过库、或 tracking/weekly 本来就要查库时写：
    // 安静的缓存命中 tick 不再为了心跳额外唤醒 Neon。
    const shouldHeartbeat =
      gates.heartbeat && (probe.checked || gates.tracking || gates.weekly);

    if (!due && !gates.tracking && !gates.weekly && !shouldHeartbeat) {
      sendJson(res, 200, {
        sent: 0,
        skipped: 0,
        failed: 0,
        email: { sent: 0, skipped: 0, failed: 0 },
        weekly: { sent: 0, skipped: 0, failed: 0 },
        tracking: { sent: 0, skipped: 0, failed: 0, checked: 0 },
        dueState: probe.cache,
      });
      return;
    }

    let snapshot: Awaited<ReturnType<typeof getDailySnapshot>> = null;
    let wecom = { sent: 0, skipped: 0, failed: 0 };
    if (due) {
      // 命中 1 小时缓存；只有过期才调企微并写 kv_cache（避免每个 due tick 都刷新）。
      await getWeComMemberCount();
      // 当天快照只构建一次：企微与邮件两个渠道共用同一轮模型产出。
      snapshot = await getDailySnapshot(now);
      // 观察：仍生成并写入 archive（面板历史用），但**不再推送到微信**；
      // 快照已经耗掉太多时间就跳过，保证简报预算。
      if (Date.now() - startedAt < 30_000) {
        try {
          await getDailyObservations(snapshot);
        } catch (err) {
          console.error('[cron] observations failed:', err);
        }
      }
      const remaining = 285_000 - (Date.now() - startedAt);
      wecom = await pushDigests(now, {
        budgetMs: Math.max(30_000, Math.min(PUSH_BUDGET_MS, remaining)),
        // cron 已经把当天的快照取出来了，pushDigests 不要再跑一次候选 SQL。
        snapshot,
      });
    }

    // 跟踪检查：只在 09:00–10:00 的两个 tick 跑；函数内部还会按 20 小时判断。
    const tracking = gates.tracking
      ? await pushTrackedChanges({
          budgetMs: Math.min(45_000, Math.max(0, 285_000 - (Date.now() - startedAt))),
        }).catch((err: unknown) => {
          console.error('[cron] tracking check failed:', err);
          return { sent: 0, skipped: 0, failed: 0, checked: 0 };
        })
      : { sent: 0, skipped: 0, failed: 0, checked: 0 };
    // cron 没有用户请求头，显式把站点根地址传进邮件推送（否则链接会回落 localhost）。
    const email =
      due
        ? await pushEmailDigests({
            snapshot,
            baseUrl: resolveBaseUrl(req.headers),
          })
        : { sent: 0, skipped: 0, failed: 0 };
    // 两个渠道都发完后刷新窗口，让下一次 tick 看到最新的 lastSentAt/lastDigestAt。
    if (due) {
      await refreshDueState(now);
    }
    // 每周复盘：只在周一 10:00–12:00 跑；函数自身仍按「本周未发」幂等。
    const weekly = gates.weekly
      ? await pushWeeklyReviews()
      : { sent: 0, skipped: 0, failed: 0 };
    // heartbeat 只在已经查过库的 tick 写；cache 字段供每日 CU 监测看命中率。
    if (shouldHeartbeat) {
      await recordHeartbeat({
        at: new Date().toISOString(),
        ok: true,
        due,
        dueState: probe.cache,
        dueWindow: probe.window,
        dueChecked: probe.checked,
        ms: Date.now() - startedAt,
        wecom,
        email,
        weekly,
        tracking,
      });
    }
    sendJson(res, 200, { ...wecom, email, weekly, tracking, dueState: probe.cache });
  } catch (err) {
    console.error('cron-push-digest failed:', err);
    // detail 供 Bearer 鉴权后的调用方排障（端点不公开，不引入暴露面）
    const detail = err instanceof Error ? err.message : String(err);
    await recordHeartbeat({
      at: new Date().toISOString(),
      ok: false,
      ms: Date.now() - startedAt,
      error: detail,
    });
    sendJson(res, 500, { error: 'push failed', detail });
  }
}
