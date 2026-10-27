import { pushDigests } from '../src/agent/digest.js';
import { getDailySnapshot } from '../src/agent/digest-snapshot.js';
import { pushWeeklyReviews } from '../src/agent/weekly-review.js';
import { pushEmailDigests } from '../src/email/push.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { refreshWeComMemberCount } from '../src/wecom/capacity.js';
import { env } from '../src/config.js';

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

  try {
    // 每小时顺带刷新成员数缓存（落地页名额门控用；失败不影响推送）。
    await refreshWeComMemberCount();
    // 当天快照只构建一次：企微与邮件两个渠道共用同一轮模型产出。
    const snapshot = await getDailySnapshot();
    const wecom = await pushDigests();
    // cron 没有用户请求头，显式把站点根地址传进邮件推送（否则链接会回落 localhost）。
    const email = await pushEmailDigests({
      snapshot,
      baseUrl: resolveBaseUrl(req.headers),
    });
    // 每周复盘：自身按「周一 10 点后 + 本周未发」幂等，每小时的 tick 都能安全调用。
    // 它永远不会抛（内部逐人隔离），所以不会把每日推送的成功响应变成 500。
    const weekly = await pushWeeklyReviews();
    sendJson(res, 200, { ...wecom, email, weekly });
  } catch (err) {
    console.error('cron-push-digest failed:', err);
    // detail 供 Bearer 鉴权后的调用方排障（端点不公开，不引入暴露面）
    const detail = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'push failed', detail });
  }
}
