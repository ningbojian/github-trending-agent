import { eq } from 'drizzle-orm';
import { env } from '../config';
import { db } from '../db/client';
import { kvCache } from '../db/schema';

/**
 * 企业微信 access_token 获取与消息推送。
 * - access_token 有效期 7200s；kv_cache 持久化 + 进程内内存缓存
 * - 距过期 < 5 分钟即提前刷新，避免临期请求失败
 */

const TOKEN_CACHE_KEY = 'wecom_access_token';
const TOKEN_TTL_SECONDS = 7200;
/** 距过期不足该阈值时视为需刷新。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface MemoryCache {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

let memoryCache: MemoryCache | undefined;
/** 进行中的取 token 操作：并发冷启动共享同一次 gettoken，避免打爆企微应用级配额。 */
let inflight: Promise<MemoryCache> | undefined;

/** 测试隔离用：清空进程内 token 缓存与 in-flight 备忘。 */
export function resetAccessTokenCache(): void {
  memoryCache = undefined;
  inflight = undefined;
}

interface TokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

async function fetchAccessTokenFromWeCom(): Promise<MemoryCache> {
  const url =
    'https://qyapi.weixin.qq.com/cgi-bin/gettoken' +
    `?corpid=${encodeURIComponent(env.WECOM_CORP_ID)}` +
    `&corpsecret=${encodeURIComponent(env.WECOM_SECRET)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`gettoken HTTP ${res.status}`);
  }
  const body = (await res.json()) as TokenResponse;
  if (body.errcode !== 0 || !body.access_token) {
    throw new Error(`gettoken failed: errcode=${body.errcode} ${body.errmsg ?? ''}`);
  }
  const ttlMs = (body.expires_in ?? TOKEN_TTL_SECONDS) * 1000;
  return { token: body.access_token, expiresAt: Date.now() + ttlMs };
}

function isFresh(entry: MemoryCache): boolean {
  return entry.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

/**
 * 获取 access_token：内存缓存 → kv_cache → 企微接口（并回写 kv_cache）。
 * 距过期 < 5 分钟即刷新。
 * 并发冷启动经 inflight 备忘去重：kv 读 + gettoken + 回写全链路只执行一次，
 * 失败后清空备忘以便下次调用重试。
 */
export async function getWeComAccessToken(): Promise<string> {
  if (memoryCache && isFresh(memoryCache)) {
    return memoryCache.token;
  }

  inflight ??= resolveAccessToken().finally(() => {
    inflight = undefined;
  });

  return (await inflight).token;
}

async function resolveAccessToken(): Promise<MemoryCache> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(eq(kvCache.key, TOKEN_CACHE_KEY));
  const row = rows[0];
  if (row) {
    const value = row.value as { token?: unknown };
    if (typeof value.token === 'string') {
      const entry: MemoryCache = {
        token: value.token,
        expiresAt: new Date(row.expiresAt).getTime(),
      };
      if (isFresh(entry)) {
        memoryCache = entry;
        return entry;
      }
    }
  }

  const fresh = await fetchAccessTokenFromWeCom();
  memoryCache = fresh;
  await db()
    .insert(kvCache)
    .values({
      key: TOKEN_CACHE_KEY,
      value: { token: fresh.token },
      expiresAt: new Date(fresh.expiresAt),
    })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: { token: fresh.token }, expiresAt: new Date(fresh.expiresAt) },
    });
  return fresh;
}

interface SendResponse {
  errcode?: number;
  errmsg?: string;
}

/** 以自建应用文本消息推送给指定成员。errcode 非 0 时抛错。 */
export async function sendWeComText(userId: string, content: string): Promise<void> {
  const token = await getWeComAccessToken();
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: userId,
        msgtype: 'text',
        agentid: Number(env.WECOM_AGENT_ID),
        text: { content },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`message/send HTTP ${res.status}`);
  }
  const body = (await res.json()) as SendResponse;
  if (body.errcode !== 0) {
    throw new Error(`message/send failed: errcode=${body.errcode} ${body.errmsg ?? ''}`);
  }
}
