import { eq } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

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

/** 网络瞬断 / HTTP 5xx 的重试退避（仅重试一次，业务 errcode 不重试）。 */
const RETRY_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * message/send 统一出站：token 获取、出站中转头、errcode 校验、瞬断重试都集中在此。
 * - 网络异常（fetch reject）/ HTTP 5xx：250ms 退避后重试一次；仍失败则抛错。
 * - HTTP 4xx / 业务 errcode≠0：不重试，直接抛错（重试只会复现同样结果）。
 */
async function postMessage(
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const token = await getWeComAccessToken();
  // 可选出站中转：配置了 WECOM_RELAY_URL 时 message/send 走固定 IP 中转（规避企微白名单），
  // 尾斜杠剥除防双斜杠路径；gettoken 不查白名单，仍直连。
  const relayUrl = env.WECOM_RELAY_URL?.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.WECOM_RELAY_SECRET) {
    headers['X-Relay-Secret'] = env.WECOM_RELAY_SECRET;
  }
  const url = `${relayUrl ?? 'https://qyapi.weixin.qq.com'}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;

  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // 网络异常 / fetch reject：重试一次（主动发送单次瞬断是线上静默主因）。
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      // 5xx 视为服务端瞬断可重试；4xx（鉴权/参数错误）重试无意义。
      if (attempt === 0 && res.status >= 500) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new Error(`message/send HTTP ${res.status}`);
    }
    const body = (await res.json()) as SendResponse;
    if (body.errcode !== 0) {
      throw new Error(`message/send failed: errcode=${body.errcode} ${body.errmsg ?? ''}`);
    }
    return;
  }
}

/**
 * 以自建应用文本消息推送给指定成员。errcode 非 0 时抛错。
 *
 * 只提供文本：企微的 markdown 消息在「微工作台」（个人微信那一侧）不可见，
 * 用户只会看到「暂时不支持此消息类型，请在企微中查看」。要在微信里读简报，
 * 就必须发 text（内容上限 2048 字节，见各调用方的安全阈值）。
 */
export async function sendWeComText(userId: string, content: string): Promise<void> {
  await postMessage(userId, {
    touser: userId,
    msgtype: 'text',
    agentid: Number(env.WECOM_AGENT_ID),
    text: { content },
  });
}
