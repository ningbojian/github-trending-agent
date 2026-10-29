import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 面板链接的版本号：重置链接 = 版本 +1，所有旧 token 立即失效。
 * 版本存 kv_cache（默认 1），与 token 里的 v 比对。
 */

const VERSION_KEY_PREFIX = 'panel-version:v1:';

function versionKey(userid: string): string {
  return `${VERSION_KEY_PREFIX}${userid}`;
}

export async function getPanelVersion(userid: string): Promise<number> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(eq(kvCache.key, versionKey(userid)));
  const row = rows[0];
  if (!row) return 1;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return 1;
  const value = row.value as { version?: unknown } | null;
  const version = value?.version;
  return typeof version === 'number' && Number.isInteger(version) && version > 0
    ? version
    : 1;
}

/** 递增并持久化版本；返回新版本号。 */
export async function bumpPanelVersion(userid: string): Promise<number> {
  const next = (await getPanelVersion(userid)) + 1;
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await db()
    .insert(kvCache)
    .values({ key: versionKey(userid), value: { version: next }, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
    });
  return next;
}
