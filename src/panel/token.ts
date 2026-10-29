import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';

/**
 * H5 面板的签名链接 token。
 *
 * 不引入 WeCom OAuth：机器人给用户发一条短期链接，点开即可看自己的数据。
 * token = base64url(payload).base64url(HMAC(payload))，payload 含 userid、
 * 过期时间与「链接版本号」——重置时递增版本，旧链接立即失效。
 *
 * 安全边界：链接可被转发，所以只放低敏数据（订阅、跟踪、收藏、历史）；
 * 不记 IP、不把 userid 写日志；7 天过期。
 */

const HMAC_PREFIX = 'panel-token:v1:';
export const PANEL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PanelPayload {
  /** userid */
  u: string;
  /** expires at (epoch ms) */
  e: number;
  /** link version */
  v: number;
}

function secret(): string {
  return `${HMAC_PREFIX}${env.TOKEN_ENCRYPT_KEY}`;
}

function b64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(input: string): Buffer | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64');
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', secret()).update(payload).digest());
}

/** 生成面板链接 token（默认 7 天）。 */
export function signPanelToken(
  userid: string,
  version: number,
  now: Date = new Date(),
  ttlMs: number = PANEL_TOKEN_TTL_MS,
): string {
  const payload: PanelPayload = {
    u: userid,
    e: now.getTime() + ttlMs,
    v: version,
  };
  const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${sign(encoded)}`;
}

/** 校验签名与过期时间；返回 userid/version，非法一律 null。 */
export function verifyPanelToken(
  token: string,
  now: Date = new Date(),
): { userid: string; version: number } | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  const left = fromB64url(signature);
  const right = fromB64url(expected);
  if (left === null || right === null || left.length !== right.length) return null;
  if (!timingSafeEqual(left, right)) return null;

  const payloadBytes = fromB64url(encoded);
  if (payloadBytes === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Partial<PanelPayload>;
  if (
    typeof record.u !== 'string' ||
    record.u === '' ||
    typeof record.e !== 'number' ||
    !Number.isFinite(record.e) ||
    typeof record.v !== 'number' ||
    !Number.isInteger(record.v)
  ) {
    return null;
  }
  if (record.e <= now.getTime()) return null;
  return { userid: record.u, version: record.v };
}
