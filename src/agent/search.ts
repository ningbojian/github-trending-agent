import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db/client';
import { repos, searchCaches, trendingEntries } from '../db/schema';
import type { SearchQuery } from './parse-query';

/** 检索单条结果：Task 9 格式化展示，"收藏 N" 按数组序号引用。 */
export interface SearchResultItem {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  starsDelta: number;
  isNew: boolean;
  /** 热榜快照日期（PG date 序列化为 'YYYY-MM-DD' 字符串）。 */
  date: string;
  htmlUrl: string;
  rank: number;
}

/** period → 回看天数窗口（all 不限时间范围）。 */
const PERIOD_DAYS: Record<Exclude<SearchQuery['period'], 'all'>, number> = {
  today: 1,
  week: 7,
  month: 30,
};

/** 转义 ILIKE 模式中的通配符（\ % _），防止用户关键词被当成模式语义。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 组装检索 SQL（trending_entries join repos）。
 * 注入纪律：标识符一律用 drizzle 列引用；语言/关键词/star 门槛/天数/topN 全部参数化。
 * - period：`date >= now() - make_interval(days => $n)`（today 1 / week 7 / month 30）
 * - languages：匹配 trending_entries.language（IN）
 * - keywords：每个关键词在 full_name / description / topics::text 上 ILIKE（字段间 OR，关键词间 AND）
 * - 去重：内层 `distinct on (full_name)`，order by full_name + 原排序语义（组内取首行）；
 *   外层按同样的排序语义（列别名）恢复排名后再 limit topN
 * - sortBy：stars_delta → stars_delta desc；stars → stars desc；new → is_new desc, rank asc
 */
function composeSearchSql(q: SearchQuery): SQL {
  const conditions: SQL[] = [];

  if (q.period !== 'all') {
    const days = PERIOD_DAYS[q.period];
    conditions.push(
      sql`${trendingEntries.date} >= now() - make_interval(days => ${days})`,
    );
  }

  if (q.languages.length > 0) {
    const languageValues = sql.join(
      q.languages.map((language) => sql`${language}`),
      sql`, `,
    );
    conditions.push(sql`${trendingEntries.language} in (${languageValues})`);
  }

  for (const keyword of q.keywords) {
    const pattern = `%${escapeLike(keyword)}%`;
    conditions.push(
      sql`(${repos.fullName} ilike ${pattern} or ${repos.description} ilike ${pattern} or ${repos.topics}::text ilike ${pattern})`,
    );
  }

  if (q.minStars !== null) {
    conditions.push(sql`${repos.stars} >= ${q.minStars}`);
  }

  const where =
    conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;

  // 内层：distinct on (full_name) 要求 order by 以 full_name 开头，
  // 原排序语义作为组内取首行的 tiebreak；外层：按同样语义（列别名）恢复排名。
  let orderTerms: SQL;
  let outerOrderTerms: SQL;
  if (q.sortBy === 'stars_delta') {
    orderTerms = sql`${trendingEntries.starsDelta} desc`;
    outerOrderTerms = sql`${sql.identifier('starsDelta')} desc`;
  } else if (q.sortBy === 'stars') {
    orderTerms = sql`${repos.stars} desc`;
    outerOrderTerms = sql`${sql.identifier('stars')} desc`;
  } else {
    orderTerms = sql`${trendingEntries.isNew} desc, ${trendingEntries.rank} asc`;
    outerOrderTerms = sql`${sql.identifier('isNew')} desc, ${sql.identifier('rank')} asc`;
  }

  return sql`
    select * from (
      select distinct on (${trendingEntries.fullName})
        ${trendingEntries.fullName} as ${sql.identifier('fullName')},
        ${repos.description} as ${sql.identifier('description')},
        ${repos.language} as ${sql.identifier('language')},
        ${repos.stars} as ${sql.identifier('stars')},
        ${trendingEntries.starsDelta} as ${sql.identifier('starsDelta')},
        ${trendingEntries.isNew} as ${sql.identifier('isNew')},
        ${trendingEntries.date} as ${sql.identifier('date')},
        ${repos.htmlUrl} as ${sql.identifier('htmlUrl')},
        ${trendingEntries.rank} as ${sql.identifier('rank')}
      from ${trendingEntries}
      join ${repos} on ${repos.fullName} = ${trendingEntries.fullName}
      ${where}
      order by ${trendingEntries.fullName}, ${orderTerms}
    ) as ${sql.identifier('deduped')}
    order by ${outerOrderTerms}
    limit ${q.topN}
  `;
}

/** 纯函数：把查询编译为 SQL 文本 + 参数，供单测断言各过滤维度组合（不触库）。 */
export function buildSearchSql(q: SearchQuery): {
  sql: string;
  params: unknown[];
} {
  const compiled = new PgDialect().sqlToQuery(composeSearchSql(q));
  return { sql: compiled.sql, params: compiled.params };
}

/**
 * 检索 Trending 并把结果按 wecomUserId 覆盖写入 search_caches
 * （先 delete 再 insert，保证每用户至多一行"最近一次检索"，供 Task 9 按序号引用）。
 */
export async function searchTrending(
  q: SearchQuery,
  wecomUserId: string,
): Promise<SearchResultItem[]> {
  const database = db();
  const { rows } = await database.execute(composeSearchSql(q));

  // SQL 已 distinct on (full_name)；此处再按 full_name 兜底去重（首行优先，
  // 与内层 order by 的 tiebreak 一致），保证同一仓库多日期/多语言行绝不重复
  // 出现在返回值与 search_caches 缓存中。
  const seen = new Set<string>();
  const items: SearchResultItem[] = [];
  for (const row of rows) {
    const item: SearchResultItem = {
      fullName: String(row.fullName),
      description: row.description == null ? null : String(row.description),
      language: row.language == null ? null : String(row.language),
      stars: Number(row.stars),
      starsDelta: Number(row.starsDelta),
      isNew: Boolean(row.isNew),
      date: String(row.date),
      htmlUrl: String(row.htmlUrl),
      rank: Number(row.rank),
    };
    if (seen.has(item.fullName)) {
      continue;
    }
    seen.add(item.fullName);
    items.push(item);
  }

  await database
    .delete(searchCaches)
    .where(eq(searchCaches.wecomUserid, wecomUserId));
  await database
    .insert(searchCaches)
    .values({ wecomUserid: wecomUserId, results: items });

  return items;
}
