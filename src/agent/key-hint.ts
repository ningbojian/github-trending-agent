import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 「配一个自己的 AI Key」提示的冷却。
 *
 * 产品背景：没有 Key 的用户，互动只有规则解析 + 共享缓存；一旦他问出需要模型的
 * 问题（深挖仓库、值不值得用），系统只能退回检索。这时候软提示一次最有价值。
 * 但不能每条都提——同一用户 7 天内最多提一次，且只在「他确实要模型」时提。
 *
 * 存储复用 kv_cache：`key-hint:v1:<userid>`，7 天 TTL。与其它缓存一样，过期行
 * 可能还在表里，所以先读再判过期，不能只看 key 是否存在。
 */
export const KEY_HINT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function keyHintKey(wecomUserid: string): string {
  return `key-hint:v1:${wecomUserid}`;
}

/**
 * 返回 true 表示这次可以提示（并记下冷却）。
 * 存储异常时返回 false：提示是锦上添花，不能因为它让搜索失败或反复刷屏。
 */
export async function takeKeyHint(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<boolean> {
  const key = keyHintKey(wecomUserid);
  try {
    const rows = await db()
      .select({ expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, key));
    const row = rows[0];
    if (row && new Date(row.expiresAt).getTime() > now.getTime()) return false;

    const value = { at: now.toISOString() };
    const expiresAt = new Date(now.getTime() + KEY_HINT_COOLDOWN_MS);
    await db()
      .insert(kvCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
    return true;
  } catch (err) {
    console.error(
      '[key-hint] take failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
