import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 短期记忆：用户上一条消息里提到的仓库（30 分钟）。
 *
 * 为什么需要：对话是连续的。「深挖 vercel/next.js」之后紧跟一句「这个项目靠不靠谱」，
 * 没有记忆就只能重新猜——模型不知道「这个」指谁，用户也只能再说一遍仓库名。
 *
 * 边界：只记仓库名，不记聊天内容；30 分钟过期；只用于工具路由的参数补位，
 * 不参与搜索排序、不进共享缓存。
 */
export const LAST_REPO_TTL_MS = 30 * 60 * 1000;

export function lastRepoKey(wecomUserid: string): string {
  return `last-repo:v1:${wecomUserid}`;
}

/** 读短期记忆；过期/不存在/异常都返回 null。 */
export async function readLastRepo(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const rows = await db()
      .select()
      .from(kvCache)
      .where(eq(kvCache.key, lastRepoKey(wecomUserid)));
    const row = rows[0];
    if (!row || new Date(row.expiresAt).getTime() <= now.getTime()) return null;
    const value = row.value as { fullName?: unknown } | null;
    return typeof value?.fullName === 'string' ? value.fullName : null;
  } catch (err) {
    // 记忆是锦上添花：读失败就当没有，不影响本轮回复。
    console.warn(
      'readLastRepo failed:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/** 记下这条消息提到的仓库（30 分钟）。失败静默。 */
export async function rememberRepo(
  wecomUserid: string,
  fullName: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const expiresAt = new Date(now.getTime() + LAST_REPO_TTL_MS);
    const value = { fullName };
    await db()
      .insert(kvCache)
      .values({ key: lastRepoKey(wecomUserid), value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
  } catch (err) {
    console.warn(
      'rememberRepo failed:',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}
