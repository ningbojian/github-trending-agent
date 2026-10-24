import { waitUntil } from '@vercel/functions';
import { env } from '../src/config.js';
import { WxbizMsgCrypt } from '../src/wecom/crypto.js';
import { routeMessage } from '../src/wecom/router.js';
import {
  buildReplyEnvelope,
  buildReplyTextXml,
  extractTag,
  parseInboundXml,
} from '../src/wecom/xml.js';

/**
 * 企业微信回调端点（Vercel Node function）。
 * - GET：URL 验证 —— 验签并解密 echostr，明文原样回传
 * - POST：验签解密 → 构造 InboundMessage → 异步分发（不 await）→ 立即 200
 *   （text 消息在响应体带加密信封的被动回执 XML，非 text 保持空串）。
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
  /**
   * Vercel addHelpers/restoreBody 会把原始请求字节回放到 data/end 事件上。
   * getBodyParser 不认识的 content-type（如企微的 text/xml）→ body 为 undefined，
   * 这个流是拿回原始报文的唯一入口。
   */
  on?(event: string, listener: (chunk?: unknown) => void): unknown;
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
  const body = req.body;
  // 已被 Vercel 解析成原始文本的路径（text/plain / 无 content-type）保持同步，
  // 5 秒规则与既有单测的同步时序断言都依赖这一点。
  if (typeof body === 'string') {
    processPost(req, body, res);
    return;
  }
  if (Buffer.isBuffer(body)) {
    processPost(req, body.toString('utf8'), res);
    return;
  }
  // Vercel getBodyParser 只解析 json / urlencoded / octet-stream / text/plain：
  // 企微真实回调的 content-type 是 text/xml，落入 default → body === undefined。
  // 原始字节没有丢——restoreBody 已把它回放到请求流上，从流读回原文再走同一条链路。
  void readReplayedBody(req).then(
    (xml) => processPost(req, xml, res),
    (err: unknown) => {
      console.error('callback raw body read failed:', err);
      res.status(401).send('invalid signature');
    },
  );
}

/** 即时回执中入站内容的截断上限（码点）。 */
export const ACK_MAX_CONTENT_CHARS = 20;

/**
 * 即时回执文案：响应发出时异步分发尚未执行，无法知道后续成败，
 * 措辞只承诺「正在处理」不承诺结果。按码点截断（emoji 计 1 个），调用方可自定义上限。
 */
export function buildAckContent(
  content: string,
  maxChars: number = ACK_MAX_CONTENT_CHARS,
): string {
  const truncated = Array.from(content).slice(0, maxChars).join('');
  return `🔍 收到，正在处理「${truncated}」…`;
}

/** 对已取得的原始 XML 报文：验签解密 → 200（text 带回执）→ 异步分发。 */
function processPost(
  req: CallbackRequest,
  xml: string,
  res: CallbackResponse,
): void {
  let plain: string;
  // makeCrypt 必须留在 try 内：AESKey 等环境配错时构造函数会抛错，
  // 此处必须落成快速 401（企微据此告警），不能逃逸成 500 / 未处理拒绝。
  // 同一 crypt 实例继续用于下方 text 回执加密（同一把密钥）。
  let crypt: WxbizMsgCrypt;
  try {
    crypt = makeCrypt();
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
  // 关键时序：不 await。先回 200 满足企微 5 秒规则，业务处理异步进行。
  // 响应发出后 Vercel 可能立刻回收实例——裸 fire-and-forget 会被掐死
  //（生产实测：200 返回但零写入），promise 必须经 waitUntil 交平台跟踪。
  waitUntil(
    routeMessage(msg).catch((err) => {
      console.error('routeMessage failed:', err);
    }),
  );
  // text 的唯一被动回复机会就在这次响应体里：带回执让用户立刻知道 agent 在运行。
  // 回调开启安全模式后明文回执会被企微静默丢弃（真机不可见）——必须先加密再套
  // Encrypt 信封返回。非 text（事件/图片等）不可被动回复，保持空串让企微静默处理。
  if (msg.msgType === 'text') {
    const replyXml = buildReplyTextXml({
      toUserName: msg.fromUserName,
      fromUserName: msg.toUserName,
      content: buildAckContent(msg.content),
    });
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    res.status(200).send(buildReplyEnvelope(crypt.encrypt(replyXml)));
    return;
  }
  res.status(200).send('');
}

/**
 * 从请求流读回原始 body（restoreBody 回放的原始字节）。
 * 5 秒兜底超时——流不发声时宁可快速 401 让企微告警，也不挂到函数超时。
 */
function readReplayedBody(req: CallbackRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof req.on !== 'function') {
      reject(new Error('callback body stream unavailable'));
      return;
    }
    let data = '';
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(
      () => settle(new Error('callback body read timeout')),
      5000,
    );
    req.on?.('data', (chunk?: unknown) => {
      data += chunk == null ? '' : String(chunk);
    });
    req.on?.('end', () => settle());
    req.on?.('error', (err?: unknown) =>
      settle(
        err instanceof Error ? err : new Error('callback body stream error'),
      ),
    );
  });
}

function makeCrypt(): WxbizMsgCrypt {
  return new WxbizMsgCrypt(
    env.WECOM_CALLBACK_TOKEN,
    env.WECOM_CALLBACK_AES_KEY,
    env.WECOM_CORP_ID,
  );
}
