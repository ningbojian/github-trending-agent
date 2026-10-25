import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';

/**
 * 「设置模型」一次性链接的凭证（HMAC 签名，无状态）。
 *
 * 流程：微信里发「设置模型」→ 回一条 `https://<域名>/api/set-key?t=<token>`；
 * 用户在浏览器打开、填接口地址/模型名/Key → POST 回同一个 token。
 * token 里只有 `{ userid, expiresAt, jti }`，**不含任何 Key**；Key 只在该
 * POST 请求体里出现一次，落库前用 AES-256-GCM 加密（github/oauth 的
 * encryptSecret）。
 *
 * 密钥 = sha256(TOKEN_ENCRYPT_KEY + ':setkey')，与 GitHub token 的加密密钥
 * 域分离：泄露一种用途的签名不会波及另一种。TTL 15 分钟，jti 用于「一次性」
 * 消费（见 api/set-key.ts 的 kv_cache 记录）。
 */

export interface SetKeyClaim {
  userid: string;
  jti: string;
}

/** 链接有效期：15 分钟。 */
export const SETKEY_TTL_MS = 15 * 60 * 1000;

/** 签名密钥（域分离）：sha256(TOKEN_ENCRYPT_KEY + ':setkey')。 */
function signingKey(): Buffer {
  return createHash('sha256')
    .update(`${env.TOKEN_ENCRYPT_KEY}:setkey`, 'utf8')
    .digest();
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload, 'utf8').digest('base64url');
}

/** 签发凭证；`now` 仅测试注入，生产省略。 */
export function signSetKeyToken(userid: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userid, e: now + SETKEY_TTL_MS, j: randomUUID() }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * 校验凭证：签名（常量时间比较）+ 结构 + 过期。任何不合法的输入都返回 null，
 * 绝不抛出 —— 调用方只做 null 判断，不必包 try。
 */
export function verifySetKeyToken(
  token: string,
  now: number = Date.now(),
): SetKeyClaim | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { u, e, j } = body as Record<string, unknown>;
  if (typeof u !== 'string' || u.length === 0) return null;
  if (typeof j !== 'string' || j.length === 0) return null;
  if (typeof e !== 'number' || !Number.isFinite(e) || e <= now) return null;
  return { userid: u, jti: j };
}
