import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { kvCache, subscribers } from '../src/db/schema.js';
import {
  encryptSecret,
  exchangeCode,
  OAUTH_STATE_PREFIX,
} from '../src/github/oauth.js';

/**
 * GitHub OAuth 回调端点（Vercel Node function，GET）。
 * 流程：校验 code&state → 按 state（一次性随机 nonce）查 kv_cache 行 →
 * 立即 DELETE 该行（一次性消费，防重放/绑定 CSRF）→ exchangeCode →
 * encryptSecret → 按映射的 wecomUserid 更新 subscribers 行 → 中文成功页。
 * state 行缺失/过期：中文错误页，零写入；exchange 失败时不产生任何 update。
 * 请求/响应最小形态与 api/cron-push-digest.ts 保持一致（不引入 @vercel/node 依赖）。
 */

/** Vercel req 的最小形态。 */
export interface OAuthRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
}

/** Vercel res 的最小形态。 */
export interface OAuthResponse {
  status(code: number): OAuthResponse;
  setHeader(name: string, value: string): OAuthResponse | void;
  send(body: string): unknown;
}

/** 取 query 首个字符串值（Vercel query 值可能是 string | string[]）。 */
function firstParam(
  query: OAuthRequest['query'],
  name: string,
): string | undefined {
  const value = query?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single == null || single === '' ? undefined : single;
}

function sendHtml(res: OAuthResponse, status: number, title: string, lines: string[]): void {
  const body =
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    `<title>${title}</title>\n</head>\n<body>\n<h1>${title}</h1>\n` +
    `${lines.map((line) => `<p>${line}</p>`).join('\n')}\n</body>\n</html>`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.status(status).send(body);
}

function errorPage(res: OAuthResponse, status: number, detail: string): void {
  sendHtml(res, status, 'GitHub 绑定失败', [
    detail,
    '请回到企业微信，向应用重新发送「绑定」后再试。',
  ]);
}

export default async function handler(
  req: OAuthRequest,
  res: OAuthResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    errorPage(res, 405, '本端点仅支持 GET 请求。');
    return;
  }

  const code = firstParam(req.query, 'code');
  const state = firstParam(req.query, 'state');
  if (!code || !state) {
    errorPage(res, 400, '缺少 code 或 state 参数，授权未完成。');
    return;
  }

  // state 是发起绑定时生成的一次性 nonce：查 kv_cache 映射行。
  const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
  const stateRows = await db()
    .select()
    .from(kvCache)
    .where(eq(kvCache.key, stateKey));
  const stateRow = stateRows[0];
  if (
    !stateRow ||
    new Date(stateRow.expiresAt).getTime() <= Date.now()
  ) {
    // 缺失或已过期：零写入（不消费、不 exchange、不 update）。
    errorPage(res, 400, '授权链接已失效或不存在，请回到企业微信重新发送「绑定」。');
    return;
  }
  const mappedUserid = (stateRow.value as { wecomUserid?: unknown }).wecomUserid;
  if (typeof mappedUserid !== 'string' || mappedUserid === '') {
    errorPage(res, 400, '授权状态数据异常，请回到企业微信重新发送「绑定」。');
    return;
  }

  // 一次性消费：立即删除 state 行，重放同一 state 时查不到行 → 错误页。
  await db().delete(kvCache).where(eq(kvCache.key, stateKey));

  let exchanged: { login: string; token: string };
  try {
    exchanged = await exchangeCode(code);
  } catch {
    // 401 / 网络错误 / 响应缺 token：不写库，只回错误页。
    errorPage(res, 502, 'GitHub 授权码兑换失败。');
    return;
  }

  const updated = await db()
    .update(subscribers)
    .set({
      githubTokenEnc: encryptSecret(exchanged.token),
      githubLogin: exchanged.login,
    })
    .where(eq(subscribers.wecomUserid, mappedUserid))
    .returning({ id: subscribers.id });

  if (updated.length === 0) {
    // 映射的 userid 匹配不到任何订阅者：什么也没写。
    errorPage(res, 404, '未找到对应的企业微信用户。');
    return;
  }

  sendHtml(res, 200, 'GitHub 绑定成功', [
    `已绑定 GitHub 账号：${exchanged.login}`,
    '现在回到企业微信，发送「我的收藏」即可测试。',
  ]);
}
