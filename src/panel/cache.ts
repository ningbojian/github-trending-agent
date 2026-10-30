import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 面板 GET 页面的短缓存。
 *
 * 面板是服务端渲染，每点一个 tab 都是一次函数调用 + 若干次 Neon 往返；
 * 同样的页面 30 秒内重复打开没有意义，直接回缓存的 HTML。
 *
 * 失效策略：
 * - 任何写操作（POST）bump 一次 `panel-dirty`，缓存键随之改变 → 下一次 GET 必回源；
 * - 键里还带面板 token 版本号：重置链接后旧缓存自然失效，不会把旧 token 的链接发出去；
 * - TTL 30 秒兜底，即使漏了 bump 也不会长期陈旧。
 *
 * 存储失败一律 fail-open：读不到就回源，写不进去就算了，页面功能不受影响。
 */
export const PANEL_CACHE_TTL_MS = 30_000;

function dirtyKey(userid: string): string {
  return `panel-dirty:v1:${userid}`;
}

function htmlKey(
  userid: string,
  version: number,
  view: string,
  dirty: string,
): string {
  return `panel-html:v1:${userid}:${version}:${dirty}:${view}`;
}

/** 读当前「脏标记」；没有记录返回空串（等同于初始状态）。 */
export async function readPanelDirty(userid: string): Promise<string> {
  try {
    const rows = await db()
      .select({ value: kvCache.value })
      .from(kvCache)
      .where(eq(kvCache.key, dirtyKey(userid)));
    const value = rows[0]?.value as { at?: unknown } | undefined;
    return typeof value?.at === 'string' ? value.at : '';
  } catch {
    return '';
  }
}

/** 写操作后调用：让所有已缓存页面立即失效。 */
export async function bumpPanelDirty(
  userid: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const key = dirtyKey(userid);
    const value = { at: now.toISOString() };
    // dirty 行永不过期（kv_cache.expires_at 非空，给个远期时间）。
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    await db()
      .insert(kvCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value } });
  } catch (err) {
    // 缓存键没变最多多陈旧 30 秒，不影响正确性。
    console.warn(
      'bumpPanelDirty failed:',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

/** 读缓存 HTML；过期或形状不对返回 null。 */
export async function readPanelHtml(
  userid: string,
  version: number,
  view: string,
  dirty: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, htmlKey(userid, version, view, dirty)));
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt === null) return null;
    if (new Date(row.expiresAt).getTime() <= now.getTime()) return null;
    const value = row.value as { html?: unknown } | undefined;
    return typeof value?.html === 'string' ? value.html : null;
  } catch {
    return null;
  }
}

/** 写缓存 HTML（30 秒）。失败静默。 */
export async function writePanelHtml(
  userid: string,
  version: number,
  view: string,
  dirty: string,
  html: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const key = htmlKey(userid, version, view, dirty);
    const value = { html };
    const expiresAt = new Date(now.getTime() + PANEL_CACHE_TTL_MS);
    await db()
      .insert(kvCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
  } catch (err) {
    console.warn(
      'writePanelHtml failed:',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}
