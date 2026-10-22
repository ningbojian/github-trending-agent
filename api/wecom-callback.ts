import { env } from '../src/config';
import { WxbizMsgCrypt } from '../src/wecom/crypto';
import { routeMessage } from '../src/wecom/router';
import { extractTag, parseInboundXml } from '../src/wecom/xml';

/**
 * 企业微信回调端点（Vercel Node function）。
 * - GET：URL 验证 —— 验签并解密 echostr，明文原样回传
 * - POST：验签解密 → 构造 InboundMessage → 异步分发（不 await）→ 立即 200 空串
 *   微信要求 5 秒内响应，业务耗时（LLM/DB）必须在响应之后。
 * 验签/解密失败一律 401（企微据此重试/告警），不回显任何内部细节。
 */

/** Vercel Node 函数时长上限（秒）：响应后仍在跑的异步分发（LLM/DB）需要余量，经 export 生效（无需 vercel.json）。 */
export const maxDuration = 300;

/** Vercel req 的最小形态（不引入 @vercel/node 依赖）。 */
export interface CallbackRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** Vercel res 的最小形态。 */
export interface CallbackResponse {
  status(code: number): CallbackResponse;
  setHeader(name: string, value: string): CallbackResponse | void;
  send(body: string): unknown;
}

/** query 值可能是 string | string[] | undefined，统一取首个字符串。 */
function q(req: CallbackRequest, name: string): string {
  const value = req.query[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function bodyToXml(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return '';
}

export default function handler(req: CallbackRequest, res: CallbackResponse): void {
  if (req.method === 'GET') {
    handleVerify(req, res);
    return;
  }
  if (req.method === 'POST') {
    handlePost(req, res);
    return;
  }
  res.status(405).send('method not allowed');
}

function handleVerify(req: CallbackRequest, res: CallbackResponse): void {
  try {
    const crypt = makeCrypt();
    const plain = crypt.verifyUrl(
      q(req, 'msg_signature'),
      q(req, 'timestamp'),
      q(req, 'nonce'),
      q(req, 'echostr'),
    );
    res.status(200).send(plain);
  } catch {
    res.status(401).send('invalid signature');
  }
}

function handlePost(req: CallbackRequest, res: CallbackResponse): void {
  const xml = bodyToXml(req.body);
  let plain: string;
  try {
    const crypt = makeCrypt();
    plain = crypt.decryptMsg(
      q(req, 'msg_signature'),
      q(req, 'timestamp'),
      q(req, 'nonce'),
      extractTag(xml, 'Encrypt'),
    );
  } catch {
    res.status(401).send('invalid signature');
    return;
  }

  const msg = parseInboundXml(plain);
  // 关键时序：不 await。先回 200 空串满足企微 5 秒规则，业务处理异步进行。
  void routeMessage(msg).catch((err) => {
    console.error('routeMessage failed:', err);
  });
  res.status(200).send('');
}

function makeCrypt(): WxbizMsgCrypt {
  return new WxbizMsgCrypt(
    env.WECOM_CALLBACK_TOKEN,
    env.WECOM_CALLBACK_AES_KEY,
    env.WECOM_CORP_ID,
  );
}
