import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { subscribers } from '../src/db/schema';
import {
  encryptSecret,
  exchangeCode,
} from '../src/github/oauth';

/**
 * GitHub OAuth 回调端点（Vercel Node function，GET）。
 * 流程：校验 code&state → exchangeCode → encryptSecret → 按 state
 * （即发起绑定时的企业微信 userid）更新 subscribers 行 → 中文成功页。
 * 任一环节失败：中文错误页，绝不写库（exchange 失败时不产生任何 update）。
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
    .where(eq(subscribers.wecomUserid, state))
    .returning({ id: subscribers.id });

  if (updated.length === 0) {
    // state 匹配不到任何订阅者：什么也没写。
    errorPage(res, 404, '未找到对应的企业微信用户。');
    return;
  }

  sendHtml(res, 200, 'GitHub 绑定成功', [
    `已绑定 GitHub 账号：${exchanged.login}`,
    '现在回到企业微信，发送「我的收藏」即可测试。',
  ]);
}
