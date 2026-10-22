import { pushDigests } from '../src/agent/digest';
import { env } from '../src/config';

/**
 * 定时推送每日简报端点（Vercel Node function）。
 * - 校验 `Authorization: Bearer <CRON_SECRET>`：缺失/错误 → 401 JSON，不做任何推送
 * - 校验通过 → pushDigests() → 200 JSON `{ sent, failed }`
 * 请求/响应最小形态与 api/wecom-callback.ts 保持一致（不引入 @vercel/node 依赖）。
 */

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
    sendJson(res, 500, { error: 'push failed' });
  }
}
