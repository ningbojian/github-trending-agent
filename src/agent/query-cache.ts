import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { SearchQuerySchema, type SearchQuery } from './parse-query.js';

/**
 * 解析结果的共享缓存：同一句话第二次问，一次模型调用都不发生。
 *
 * 为什么按文本全局共享（不按用户）：解析 prompt 里没有任何用户上下文，
 * 同一句话该被解析成什么，跟谁在问无关；全局共享才能拿到最高命中率。
 * key 里带 `v1`，将来改 prompt 时换个版本号即可整批失效。
 *
 * 为什么复用 kv_cache 而不建表：迁移 0004 的 journal 时间戳会早于
 * 0003（1793200000001），drizzle 会静默跳过——为一个 30 天过期的缓存
 * 去碰这个坑不值。详见 docs/deploy.md 第 1 节。
 *
 * 缓存是优化而不是正确性依赖：读或写失败一律当作未命中，绝不冒泡。
 */

const CACHE_PREFIX = 'parse:v1:';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 空白差异不该产生两个缓存条目（`本周  rust` 与 `本周 rust` 是同一句）。 */
export function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function queryCacheKey(text: string): string {
  const digest = createHash('sha1')
    .update(normalizeQueryText(text))
    .digest('hex');
  return `${CACHE_PREFIX}${digest}`;
}

/** 读缓存；无行、已过期、值不合 schema、库不可用都返回 null。 */
export async function readCachedQuery(text: string): Promise<SearchQuery | null> {
  try {
    const rows = await db()
      .select()
      .from(kvCache)
      .where(eq(kvCache.key, queryCacheKey(text)));
    const row = rows[0];
    if (!row) {
      return null;
    }
    // 过期判定放在代码里：不依赖数据库时钟，也方便单测。
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    const parsed = SearchQuerySchema.safeParse(row.value);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.error(
      '[query-cache] read failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** 写缓存；失败只记日志，不影响本次回复。 */
export async function writeCachedQuery(
  text: string,
  query: SearchQuery,
): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: queryCacheKey(text),
        value: query,
        expiresAt: new Date(Date.now() + TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.error(
      '[query-cache] write failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
