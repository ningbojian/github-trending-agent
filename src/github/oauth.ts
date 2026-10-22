import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { env } from '../config';
import { sendWeComText } from '../wecom/api';
import type { InboundMessage } from '../wecom/router';

/**
 * GitHub OAuth 绑定：
 * - buildAuthorizeUrl：拼授权链接（scope 固定 public_repo，最小权限）
 * - exchangeCode：code → access_token → 拉取用户 login
 * - encryptSecret/decryptSecret：AES-256-GCM 加密用户 token 后入库
 *   （独立实现，不复用 WeCom 的 WXBizMsgCrypt——其格式与企业微信协议绑定）
 * - bindHandler：「绑定」消息 → 回复授权链接
 */

/** 授权范围：仅 public_repo（Global Constraint：最小权限，够 star 仓库即可）。 */
export const OAUTH_SCOPE = 'public_repo';

// ---------------------------------------------------------------------------
// 授权链接
// ---------------------------------------------------------------------------

/** 拼 GitHub OAuth 授权链接；state 携带企业微信 userid，回调时凭它定位订阅者。 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// code 换 token
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUser {
  login?: string;
}

/**
 * 用授权 code 换取 access_token，并拉取用户 login。
 * HTTP 非 2xx、响应缺 access_token、拉 user 失败均抛错（由调用方兜住转错误页）。
 */
export async function exchangeCode(
  code: string,
): Promise<{ login: string; token: string }> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    throw new Error(`github token exchange HTTP ${res.status}`);
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) {
    throw new Error(
      `github token exchange failed: ${body.error ?? body.error_description ?? 'missing access_token'}`,
    );
  }
  const token = body.access_token;

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    throw new Error(`github user fetch HTTP ${userRes.status}`);
  }
  const user = (await userRes.json()) as GithubUser;
  if (!user.login) {
    throw new Error('github user fetch: missing login');
  }
  return { login: user.login, token };
}

// ---------------------------------------------------------------------------
// token 加解密（AES-256-GCM，密钥由 TOKEN_ENCRYPT_KEY 派生）
// ---------------------------------------------------------------------------

const ALGO = 'aes-256-gcm';
/** GCM 推荐 IV 长度 12 字节。 */
const IV_BYTES = 12;
/** GCM 认证标签 16 字节。 */
const TAG_BYTES = 16;

/** 密钥派生：sha256(TOKEN_ENCRYPT_KEY)（确定性，32 字节正好喂 aes-256）。 */
function encryptionKey(): Buffer {
  return createHash('sha256').update(env.TOKEN_ENCRYPT_KEY, 'utf8').digest();
}

/**
 * 加密明文（用户 GitHub token）。
 * 输出 base64(iv(12) || tag(16) || ciphertext)，每次随机 IV。
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** 解密 encryptSecret 的输出；篡改/畸形输入经 GCM 校验后抛错。 */
export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('decryptSecret: payload too short');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// bindHandler
// ---------------------------------------------------------------------------

/** 「绑定」回复的固定前缀（全中文交互文案）。 */
export const BIND_REPLY_PREFIX =
  '请点击以下链接完成 GitHub 授权（授权范围仅 public_repo，用于帮你 star 仓库）：';

/** 「绑定」回复的固定尾句。 */
export const BIND_REPLY_SUFFIX = '授权完成后，回到企业微信发送「我的收藏」即可测试。';

/**
 * 绑定 handler：回复带 state=发送者 userid 的 GitHub 授权链接。
 * 由 router 在模块作用域注册（content 精确等于「绑定」才命中）。
 */
export async function bindHandler(msg: InboundMessage): Promise<void> {
  const url = buildAuthorizeUrl(msg.fromUserName);
  await sendWeComText(
    msg.fromUserName,
    `${BIND_REPLY_PREFIX}\n${url}\n${BIND_REPLY_SUFFIX}`,
  );
}
