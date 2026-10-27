import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { searchCaches } from '../db/schema.js';

/**
 * 调用方最近一次检索缓存（search_caches 每用户至多一行，仍按创建时间倒序兜底）。
 *
 * 区分三态：无行（found=false，从未搜索/简报）/ 有行但结果为空 / 有行有结果——
 * 让「收藏 N」「感兴趣」能给出精确文案，不把"没有缓存"谎报成"没有第 N 条"。
 */

/** 缓存条目只需 full_name；其余字段由检索流程写入，这里不消费。 */
export interface RecentResultItem {
  fullName: string;
}

export async function loadRecentResults(
  wecomUserid: string,
): Promise<{ found: boolean; items: RecentResultItem[] }> {
  const rows = await db()
    .select()
    .from(searchCaches)
    .where(eq(searchCaches.wecomUserid, wecomUserid))
    .orderBy(desc(searchCaches.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { found: false, items: [] };
  }
  const results = row.results;
  return {
    found: true,
    items: Array.isArray(results) ? (results as RecentResultItem[]) : [],
  };
}
