import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { getWeComAccessToken, getWeComAccessTokenForSecret } from './api.js';

/**
 * 企业微信「加入企业」二维码（best-effort）。
 *
 * 企微的加入二维码只对 7 天有效（`corp/get_join_qrcode` 的 `join_qrcode`
 * 明确标注有效期 7 天），所以不能把它截图成静态 PNG 长期使用。
 * 这里按天刷新并缓存 6 天：
 * - 缓存未满 24 小时 → 直接用；
 * - 超过 24 小时 → 取新码，失败时回退到仍在有效期内的旧码；
 * - 没有可用缓存且接口失败 → 返回 null，页面降级为「向管理员索要邀请链接」。
 */

const CACHE_KEY = 'wecom:join-qr:v1';
/** 每天刷新一次，留足 6 天余量。 */
const REFRESH_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface JoinQrResponse {
  errcode?: number;
  errmsg?: string;
  join_qrcode?: unknown;
}

interface CachedJoinQr {
  url?: unknown;
  fetchedAt?: unknown;
}

interface ValidCache {
  url: string;
  fetchedAt: number;
  expiresAt: number;
}

async function readCache(): Promise<ValidCache | null> {
  try {
    const rows = await db()
      .select()
      .from(kvCache)
      .where(sql`${kvCache.key} = ${CACHE_KEY}`);
    const row = rows[0];
    if (!row) return null;
    const value = row.value as CachedJoinQr;
    if (typeof value.url !== 'string' || typeof value.fetchedAt !== 'string') {
      return null;
    }
    const fetchedAt = Date.parse(value.fetchedAt);
    if (!Number.isFinite(fetchedAt)) return null;
    return {
      url: value.url,
      fetchedAt,
      expiresAt: new Date(row.expiresAt).getTime(),
    };
  } catch (err) {
    console.error('join qr cache read failed:', err);
    return null;
  }
}

async function fetchJoinQr(contactsSecret?: string): Promise<string | null> {
  try {
    // 官方权限说明：须拥有通讯录管理权限，使用通讯录同步的 Secret。
    // 没有配置时退回应用 token（多数企业会因权限不足失败，页面再降级）。
    const token = contactsSecret
      ? await getWeComAccessTokenForSecret(
          contactsSecret,
          'wecom_contacts_access_token',
        )
      : await getWeComAccessToken();
    // 通讯录同步有「企业可信 IP」白名单时，Vercel 动态出口会被 60020 拒绝；
    // 复用 message/send 的固定 IP 中转，把中转 IP 加进通讯录同步白名单即可。
    const relayUrl = process.env.WECOM_RELAY_URL?.trim().replace(/\/+$/, '');
    const relaySecret = process.env.WECOM_RELAY_SECRET?.trim();
    const base = relayUrl || 'https://qyapi.weixin.qq.com';
    const headers: Record<string, string> = {};
    if (relayUrl && relaySecret) headers['X-Relay-Secret'] = relaySecret;
    const url =
      `${base}/cgi-bin/corp/get_join_qrcode` +
      `?access_token=${encodeURIComponent(token)}&size_type=3`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`get_join_qrcode HTTP ${res.status}`);
    const body = (await res.json()) as JoinQrResponse;
    if (
      body.errcode !== 0 ||
      typeof body.join_qrcode !== 'string' ||
      body.join_qrcode.length === 0
    ) {
      throw new Error(
        `get_join_qrcode failed: errcode=${body.errcode} ${body.errmsg ?? ''}`,
      );
    }
    return body.join_qrcode.replace(/^http:\/\//, 'https://');
  } catch (err) {
    console.error('getJoinQrUrl fetch failed:', err);
    return null;
  }
}

async function writeCache(url: string, now: Date): Promise<void> {
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  try {
    await db()
      .insert(kvCache)
      .values({ key: CACHE_KEY, value: { url, fetchedAt }, expiresAt })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: { url, fetchedAt }, expiresAt },
      });
  } catch (err) {
    console.error('join qr cache write failed:', err);
  }
}

/** 返回当前可用的加入企业二维码图片 URL；没有任何可用码时返回 null。 */
export async function getJoinQrUrl(
  now: Date = new Date(),
  contactsSecret?: string,
): Promise<string | null> {
  const nowMs = now.getTime();
  const cached = await readCache();
  const cacheUsable = cached !== null && cached.expiresAt > nowMs;

  if (cacheUsable && nowMs - cached.fetchedAt < REFRESH_MS) {
    return cached.url;
  }

  const fresh = await fetchJoinQr(contactsSecret);
  if (fresh !== null) {
    await writeCache(fresh, now);
    return fresh;
  }

  // 接口挂了但旧码还没到 7 天：继续用，避免页面直接失去入口。
  return cacheUsable ? cached.url : null;
}
