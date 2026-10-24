import { pushDigests } from '../src/agent/digest.js';
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
    const result = await pushDigests();
    sendJson(res, 200, result);
  } catch (err) {
    console.error('cron-push-digest failed:', err);
    // detail 供 Bearer 鉴权后的调用方排障（端点不公开，不引入暴露面）
    const detail = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'push failed', detail });
  }
}
