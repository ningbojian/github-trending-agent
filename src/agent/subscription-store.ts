/**
 * 订阅者偏好的读写入口（subscribers.preferences + active）。
 *
 * 为什么单独一个文件：写入侧过去散在 onboarding 的每个 handler 里，各写一遍
 * 「读-合并-写」，新增一个字段就要改四处、忘一处就丢设置。这里收成一个
 * mergePreferences：只改 patch 里的键，未知字段原样保留。
 *
 * 失败语义：
 * - 读失败**照原样抛**，让调用方能区分「没有订阅者行」与「读不到」——
 *   把 DB 故障说成「你没有订阅」是最伤人的假话。
 * - 写失败也抛：回执绝不能谎称改成功。
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscribers } from '../db/schema.js';

/** 库里 preferences 的列类型（含确定字段；运行时可能还有历史遗留键）。 */
type StoredPreferences = typeof subscribers.$inferSelect.preferences;

/** 偏好对象：已知键可缺省，未知键原样放过（合并时绝不丢）。 */
export interface SubscriptionPreferences {
  languages?: unknown;
  keywords?: unknown;
  digestCount?: unknown;
  pushTime?: unknown;
  intervalDays?: unknown;
  [key: string]: unknown;
}

/** 一次订阅快照：active 与原始偏好（未规范化，展示侧自行决定怎么显示）。 */
export interface SubscriptionSnapshot {
  active: boolean;
  preferences: SubscriptionPreferences;
}

/** 新行/缺字段时的底：与 schema 的默认值一致。 */
const EMPTY_PREFERENCES: SubscriptionPreferences = { languages: [], keywords: [] };

/**
 * 读订阅者当前设置。没有该用户的行 → null；DB 错误原样抛（不吞）。
 */
export async function readSubscription(
  wecomUserid: string,
): Promise<SubscriptionSnapshot | null> {
  const rows = await db()
    .select({ preferences: subscribers.preferences, active: subscribers.active })
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, wecomUserid));
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { active: row.active, preferences: row.preferences as SubscriptionPreferences };
}

/**
 * 读-合并-写：只改 patch 里的键，其余（含未来新增的未知键）原样保留。
 * - 没有订阅者行时以空偏好为底（调用方通常是「订阅」恢复流程，会同时传 active）；
 * - `options.active` 仅在显式给出时写入——普通偏好修改绝不误改退订状态。
 */
export async function mergePreferences(
  wecomUserid: string,
  patch: SubscriptionPreferences,
  options?: { active?: boolean },
): Promise<void> {
  const current = await readSubscription(wecomUserid);
  const preferences: SubscriptionPreferences = {
    ...(current?.preferences ?? EMPTY_PREFERENCES),
    ...patch,
  };
  const values: { preferences: StoredPreferences; active?: boolean } = {
    preferences: preferences as StoredPreferences,
  };
  if (options?.active !== undefined) {
    values.active = options.active;
  }
  await db()
    .update(subscribers)
    .set(values)
    .where(eq(subscribers.wecomUserid, wecomUserid));
}

/**
 * 从偏好关键词里删掉一个词（大小写不敏感、整词匹配）。
 * - 命中：写回删完后的 keywords，返回 removed=true；
 * - 没命中 / 没有订阅者行：**不写库**，返回 removed=false（回执据此说「没找到」）；
 * - 绝不碰 active：退订只能靠「退订」，删关键词不是退订的同义词。
 */
export async function removeSubscriptionTerm(
  wecomUserid: string,
  term: string,
): Promise<{ removed: boolean; keywords: string[] }> {
  const current = await readSubscription(wecomUserid);
  const raw = current?.preferences.keywords;
  const keywords = Array.isArray(raw)
    ? raw.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const target = term.trim().toLowerCase();
  const remaining = keywords.filter((keyword) => keyword.toLowerCase() !== target);
  if (remaining.length === keywords.length) {
    return { removed: false, keywords };
  }
  await mergePreferences(wecomUserid, { keywords: remaining });
  return { removed: true, keywords: remaining };
}
