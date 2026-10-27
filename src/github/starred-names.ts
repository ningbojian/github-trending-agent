import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { normalizeRepoName } from '../agent/repo-name.js';
import { decryptSecret } from './oauth.js';

/**
 * 网页端 star 名单（只读）。
 *
 * 用户很可能是在 GitHub 网页上点的 star：本地 favorites 没有对应行，
 * 于是「已经收藏的仓库又被推进简报」——这正是本轮要修的四个漏点之一。
 *
 * 成本控制：每个用户每天最多一次 GitHub 请求（kv_cache 24 小时）。
 * 上限 MAX_STARRED_NAMES 条——超过的旧 star 仍可能漏（已知限制，见 docs）。
 * 任何失败都只降级、不抛：最差只是这次不做额外过滤，绝不能把推送弄挂。
 */

/** 缓存 24 小时：star 变化不需要实时，一天一次足够。 */
export const STARRED_NAMES_TTL_MS = 24 * 60 * 60 * 1000;
/** 一次最多看 100 个 star（GitHub 单页上限）；更早的 star 不参与过滤。 */
export const MAX_STARRED_NAMES = 100;

export interface StarredNames {
  names: string[];
  /** 是否来自缓存（true = 本次没调 GitHub）。 */
  cached: boolean;
}

function cacheKey(userid: string): string {
  return `stars:v1:${userid}`;
}

/** 缓存值 → 归一后的名字；形状不对返回 null（当作没有缓存）。 */
function parseNames(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as { names?: unknown }).names;
  if (!Array.isArray(raw)) return null;
  return normalizeAll(raw);
}

function normalizeAll(raw: unknown[]): string[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = normalizeRepoName(entry);
    if (name !== '') seen.add(name);
    if (seen.size >= MAX_STARRED_NAMES) break;
  }
  return [...seen];
}

type CacheRow = { names: string[]; fresh: boolean };

/**
 * 读缓存行。过期的行也返回（fresh: false），好在刷新失败时兜底：
 * 多过滤一个用户早就 unstar 的仓库，比把他已经收藏的又推一遍要好。
 */
async function readCache(userid: string, now: Date): Promise<CacheRow | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, cacheKey(userid)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const names = parseNames(row.value);
    if (names === null) return null;
    return { names, fresh: row.expiresAt.getTime() > now.getTime() };
  } catch (err) {
    console.warn('[starred-names] cache read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function writeCache(userid: string, names: string[], now: Date): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: cacheKey(userid),
        value: { names },
        expiresAt: new Date(now.getTime() + STARRED_NAMES_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.warn('[starred-names] cache write failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * 拉 star 名单。失败返回 null（调用方用旧值兜底或跳过）。
 *
 * 用公开端点 `/users/{login}/starred`：与「我的收藏」一致，只需 `public_repo`
 * 权限，换权限会让已绑定用户全部重新授权。带上 token 只是为了拿认证后的速率额度。
 */
async function fetchStarredNames(token: string, login: string): Promise<string[] | null> {
  const url =
    `https://api.github.com/users/${encodeURIComponent(login)}/starred` +
    `?sort=created&direction=desc&per_page=${MAX_STARRED_NAMES}`;
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status !== 200) {
      console.warn(`[starred-names] ${login}: HTTP ${res.status}`);
      return null;
    }
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return null;
    return normalizeAll(
      raw.map((row) =>
        typeof row === 'object' && row !== null
          ? (row as { full_name?: unknown }).full_name
          : undefined,
      ),
    );
  } catch (err) {
    console.warn(`[starred-names] ${login}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 读某个用户的 GitHub star 名单（归一成小写）。
 *
 * - `tokenEnc` / `login` 为空（未绑定）→ 立刻 null：不读缓存、不请求、不写缓存。
 * - 缓存未过期 → 直接返回，零网络、零解密。
 * - 需要刷新 → 解密 token 后拉取；成功写 24 小时缓存，失败用过期旧值兜底，再不行 null。
 *
 * 收**密文**而不是明文：解密属于 github 层，调用方（推送路径）手里正好有
 * subscribers 行里的 `github_token_enc`，不需要为了这个再读一次库。
 */
export async function loadStarredNames(
  userid: string,
  tokenEnc: string | null,
  login: string | null,
  now: Date = new Date(),
): Promise<StarredNames | null> {
  if (tokenEnc === null || tokenEnc === '' || login === null || login === '') return null;

  const cached = await readCache(userid, now);
  if (cached !== null && cached.fresh) {
    return { names: cached.names, cached: true };
  }

  let token: string;
  try {
    token = decryptSecret(tokenEnc);
  } catch (err) {
    // 密文损坏 / 密钥轮换：旧的 star 名单仍然有效（只用来「不推」），照用。
    console.warn('[starred-names] decrypt failed:', err instanceof Error ? err.message : err);
    return cached === null ? null : { names: cached.names, cached: true };
  }

  const fetched = await fetchStarredNames(token, login);
  if (fetched === null) {
    return cached === null ? null : { names: cached.names, cached: true };
  }

  await writeCache(userid, fetched, now);
  return { names: fetched, cached: false };
}
