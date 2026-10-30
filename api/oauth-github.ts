import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { kvCache, subscribers } from '../src/db/schema.js';
import { escapeHtml } from '../src/http/html.js';
import { renderMessagePage } from '../src/ui/page.js';
import {
  encryptSecret,
  exchangeCode,
  OAUTH_STATE_PREFIX,
  safeReturnPath,
} from '../src/github/oauth.js';
import { importGithubStars } from '../src/github/stars.js';

/**
 * GitHub OAuth 回调端点（Vercel Node function，GET）。
 * 流程：校验 code&state → 按 state（一次性随机 nonce）查 kv_cache 行 →
 * 立即 DELETE 该行（一次性消费，防重放/绑定 CSRF）→ exchangeCode →
 * encryptSecret → 按映射的 wecomUserid 更新 subscribers 行 → 中文成功页。
 * state 行缺失/过期：中文错误页，零写入；exchange 失败时不产生任何 update。
 * 请求/响应最小形态与 api/cron-push-digest.ts 保持一致（不引入 @vercel/node 依赖）。
 *
 * 视觉：成功/失败页都走统一页壳（viewport、品牌头、favicon），
 * 不再返回裸 <h1>；login 一律转义。
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

/**
 * 成功页（纯函数，供测试）。login 来自 GitHub，仍按不可信输入转义。
 * returnPath 存在时（面板发起的绑定）给一个「返回面板」按钮，用户不必回微信。
 */
export function renderOauthSuccess(
  login: string,
  returnPath?: string | null,
): string {
  const back =
    returnPath == null
      ? ''
      : `<div class="p-actions"><a class="p-btn" href="${escapeHtml(returnPath)}">返回面板</a></div>`;
  return renderMessagePage({
    title: 'GitHub 绑定成功',
    tone: 'ok',
    message: '已绑定 GitHub 账号。',
    extraHtml: `<div class="p-kv"><div><dt>账号</dt><dd>${escapeHtml(login)}</dd></div></div>
      ${back}
      <p class="p-hint">${
        returnPath == null
          ? '现在回到企业微信，发送「我的收藏」即可测试。'
          : '现在可以在面板里直接收藏，也会同步到你的 GitHub star。'
      }</p>`,
  });
}

/** 失败页（纯函数，供测试）。detail 也统一转义，避免以后有人拼动态文案。 */
export function renderOauthError(detail: string): string {
  return renderMessagePage({
    title: 'GitHub 绑定失败',
    tone: 'err',
    message: detail,
    extraHtml: '<p class="p-hint">请回到企业微信，向应用重新发送「绑定」后再试。</p>',
  });
}

function sendRendered(res: OAuthResponse, status: number, html: string): void {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}

function errorPage(res: OAuthResponse, status: number, detail: string): void {
  sendRendered(res, status, renderOauthError(detail));
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
  // 面板发起的绑定会带上站内返回路径；只接受同站绝对路径。
  const mappedReturn = safeReturnPath(
    (stateRow.value as { returnPath?: unknown }).returnPath,
  );

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

  // 绑定成功顺手把 GitHub 上已有的 star 导入本地收藏（最多 100 个）。
  // 失败不影响绑定结果，面板里还有手动「同步收藏」按钮。
  try {
    await importGithubStars(mappedUserid, exchanged.token, exchanged.login);
  } catch (err) {
    console.warn('importGithubStars after bind failed:', err);
  }

  sendRendered(res, 200, renderOauthSuccess(exchanged.login, mappedReturn));
}
