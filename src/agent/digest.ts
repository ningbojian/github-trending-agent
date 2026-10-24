import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { repos, searchCaches, subscribers, trendingEntries } from '../db/schema.js';
import { sendWeComMarkdown } from '../wecom/api.js';
import { formatEntryLine } from '../wecom/markdown.js';
import { loadRepoSummaries } from './repo-summary.js';

/**
 * 每日简报：按订阅者偏好取近 7 天 topN 热榜条目，每条一行
 * （仓库可点链接 + 中文简介），走企微 markdown 通道推送。
 * 简介经 loadRepoSummaries（Task 1）批量生成 + 全局 kv 缓存，失败自动降级，
 * repo 列表永远存在。
 *
 * 数据获取不复用 searchTrending：后者按"用户最近一次检索"的语义写 search_caches，
 * 每日定时任务不该借用那条通道；推送成功后本模块用 saveRecentResults 按
 * **消息实际展示的顺序**（含 digestCount 与 3800 字节截断）覆盖写 search_caches，
 * 让用户收到简报后直接「收藏 N」即可引用其中条目；用户随后搜索会正常覆盖。
 */

/** 简报榜单周期：近 7 天（周榜）。 */
const PERIOD_DAYS = 7;
/** 候选池大小：关键词轻量排序后取前 N 条。 */
const POOL_SIZE = 20;
/** 简报默认条数（用户未设置 digestCount 时）。 */
export const DEFAULT_DIGEST_COUNT = 10;
/** 简报条数下限（「条数 N」指令在 handler 层拦截 0/负数；此处 clamp 兜底脏数据）。 */
export const MIN_DIGEST_COUNT = 1;
/** 简报条数上限（成本护栏）。 */
export const MAX_DIGEST_COUNT = 20;
/** 企微 markdown 4096 字节上限的安全阈值（与搜索回复一致）。 */
const MAX_DIGEST_BYTES = 3800;
/** 截断标注。 */
const TRUNCATION_NOTE = '（内容过长，已截断）';
/** 榜单为空时的占位文案。 */
const EMPTY_NOTICE = '今日暂无符合条件的热榜项目。';
/** 简报页脚：收藏指引 + 帮助指引（与搜索结果页脚措辞略异，保持各自语境）。 */
export const DIGEST_FOOTER =
  '💡 回复「收藏 N」收藏任意一条；发「帮助」查看全部指令';

/** 简报单条：join 后的仓库 + 热榜快照字段。 */
interface DigestEntry {
  fullName: string;
  description: string | null;
  topics: string[];
  stars: number;
  starsDelta: number;
  isNew: boolean;
  htmlUrl: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 北京时间日期（YYYY-MM-DD）。
 * Vercel 运行时为 UTC：直接 toISOString 会在早上 8 点前错前一天，
 * 简报头部日期必须按东八区计算。Task 5 的推送时间门控复用同一时区约定。
 */
export function shanghaiToday(now: Date = new Date()): string {
  return shanghaiDateFormatter.format(now);
}

function headerLine(date: string): string {
  return `📊 今日 GitHub 热榜简报（${date}）`;
}

/**
 * 组装 topN 查询 SQL（trending_entries join repos）。
 * - 近 7 天窗口：`date >= now() - make_interval(days => 7)`
 * - languages 非空：`lower(repos.language) IN (...)`（参数化；偏好已小写化，
 *   repos.language 为 null 时 lower(null) 不匹配即天然排除）；空 → 不过滤（全量榜）
 * - 去重：`distinct on (full_name)`，组内取 stars_delta 最大的一行
 * - 外层按 stars_delta 降序取候选池
 */
function composeTopSql(languages: string[]): SQL {
  const conditions: SQL[] = [
    sql`${trendingEntries.date} >= now() - make_interval(days => ${PERIOD_DAYS})`,
  ];
  if (languages.length > 0) {
    const languageValues = sql.join(
      languages.map((language) => sql`${language}`),
      sql`, `,
    );
    conditions.push(sql`lower(${repos.language}) in (${languageValues})`);
  }

  return sql`
    select * from (
      select distinct on (${trendingEntries.fullName})
        ${trendingEntries.fullName} as ${sql.identifier('fullName')},
        ${repos.description} as ${sql.identifier('description')},
        ${repos.topics} as ${sql.identifier('topics')},
        ${repos.stars} as ${sql.identifier('stars')},
        ${repos.htmlUrl} as ${sql.identifier('htmlUrl')},
        ${trendingEntries.starsDelta} as ${sql.identifier('starsDelta')},
        ${trendingEntries.isNew} as ${sql.identifier('isNew')}
      from ${trendingEntries}
      join ${repos} on ${repos.fullName} = ${trendingEntries.fullName}
      where ${sql.join(conditions, sql` and `)}
      order by ${trendingEntries.fullName}, ${trendingEntries.starsDelta} desc
    ) as ${sql.identifier('deduped')}
    order by ${sql.identifier('starsDelta')} desc
    limit ${POOL_SIZE}
  `;
}

async function fetchTopEntries(languages: string[]): Promise<DigestEntry[]> {
  const { rows } = await db().execute(composeTopSql(languages));

  // SQL 已 distinct on (full_name)；此处再按 full_name 兜底去重（与检索一致）。
  const seen = new Set<string>();
  const entries: DigestEntry[] = [];
  for (const row of rows) {
    const fullName = String(row.fullName);
    if (seen.has(fullName)) {
      continue;
    }
    seen.add(fullName);
    entries.push({
      fullName,
      description: row.description == null ? null : String(row.description),
      topics: Array.isArray(row.topics) ? row.topics.map((t) => String(t)) : [],
      stars: Number(row.stars),
      starsDelta: Number(row.starsDelta),
      isNew: Boolean(row.isNew),
      htmlUrl: row.htmlUrl == null ? '' : String(row.htmlUrl),
    });
  }
  return entries;
}

function matchesKeyword(entry: DigestEntry, keyword: string): boolean {
  return (
    entry.fullName.toLowerCase().includes(keyword) ||
    (entry.description ?? '').toLowerCase().includes(keyword) ||
    entry.topics.some((topic) => topic.toLowerCase().includes(keyword))
  );
}

/**
 * keywords 轻量应用：命中任一关键词的条目稳定地排到前面（Array.sort 稳定，
 * 同分保持 stars_delta 顺序），不丢弃任何条目 —— 关键词只影响排序，
 * 列表绝不因关键词清空。
 */
function rankByPreferences(
  entries: DigestEntry[],
  keywords: string[],
): DigestEntry[] {
  const active = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
  if (active.length === 0) {
    return entries;
  }
  return [...entries].sort(
    (a, b) =>
      Number(active.some((keyword) => matchesKeyword(b, keyword))) -
      Number(active.some((keyword) => matchesKeyword(a, keyword))),
  );
}

/**
 * 加载仓库中文简介；失败时降级为空 Map（该批条目省略简介），
 * 绝不因摘要失败丢掉整份简报。
 */
async function loadSummariesSafe(
  entries: DigestEntry[],
): Promise<Map<string, string>> {
  try {
    return await loadRepoSummaries(entries);
  } catch (err) {
    console.error('loadRepoSummaries failed (degrade to no-summary):', err);
    return new Map();
  }
}

/**
 * 头部 + 单行列表 + 页脚拼接；超过 3800 字节时从尾部逐条丢弃并标注截断。
 * 空列表只回占位文案（无可收藏条目，不带收藏页脚）。
 * 返回 keptCount：最终消息里实际展示的条目数（供 entries 与缓存对齐）。
 */
function assemble(
  header: string,
  lines: string[],
): { text: string; keptCount: number } {
  if (lines.length === 0) {
    return { text: `${header}\n\n${EMPTY_NOTICE}`, keptCount: 0 };
  }
  const build = (kept: string[], truncated: boolean): string => {
    const parts = [header, '', ...kept];
    if (truncated) {
      parts.push(TRUNCATION_NOTE);
    }
    parts.push(DIGEST_FOOTER);
    return parts.join('\n');
  };
  const full = build(lines, false);
  if (byteLength(full) <= MAX_DIGEST_BYTES) {
    return { text: full, keptCount: lines.length };
  }
  let kept = lines;
  while (kept.length > 0) {
    kept = kept.slice(0, -1);
    const candidate = build(kept, true);
    if (byteLength(candidate) <= MAX_DIGEST_BYTES) {
      return { text: candidate, keptCount: kept.length };
    }
  }
  // 理论不可达：截断标注 + 页脚本身远小于 3800 字节。
  return { text: build([], true), keptCount: 0 };
}

/** 关键词标点清洗：与 parse-query 同一字符集（修复存量 preferences 里的 "AI。"）。 */
const KEYWORD_PUNCT_RE = /[。！？!?；;，,、()（）]/g;

/**
 * preferences 运行时防御：字段缺失/非数组一律按空处理（languages 空 → 全量）；
 * keywords 去中英文标点后 trim/lowercase（读取侧清洗存量脏数据，逻辑与 parse-query 一致）；
 * languages 只 trim/lowercase（语言过滤逻辑不变）；
 * digestCount 非有限数字（含字符串/NaN/缺失）→ 默认 10，有限数字 → clamp 1–20。
 */
function normalizePreferences(preferences: {
  languages?: unknown;
  keywords?: unknown;
  digestCount?: unknown;
}): { languages: string[]; keywords: string[]; digestCount: number } {
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : [];
  const keywordList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => String(item).replace(KEYWORD_PUNCT_RE, '').trim().toLowerCase())
          .filter(Boolean)
      : [];
  const rawCount = preferences.digestCount;
  const digestCount =
    typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.min(MAX_DIGEST_COUNT, Math.max(MIN_DIGEST_COUNT, Math.floor(rawCount)))
      : DEFAULT_DIGEST_COUNT;
  return {
    languages: list(preferences.languages),
    keywords: keywordList(preferences.keywords),
    digestCount,
  };
}

/**
 * 构建单个订阅者的每日简报文本 + 消息里实际展示的可收藏条目
 * （全中文文案，markdown 单行 + 链接 + 中文简介）。
 * - preferences.languages 为空/缺失 → 全量语言榜；非空（已小写化）→ lower(repos.language) IN 过滤
 * - keywords 轻量提升排序（不丢弃条目）
 * - 条数按 preferences.digestCount（clamp 1–20，默认 10）
 * - 头部日期按北京时间（now 可注入，供测试与 Task 5 复用）
 * - 简介失败（null/抛错/缓存未命中降级）→ 无破折号后段，repo 列表始终存在
 * - entries 顺序 = 消息行顺序（排序 + digestCount 截断 + 3800 字节截断之后）；
 *   空榜 → []。「收藏 N」按此序号引用，绝不指向消息里看不到的条目。
 */
export async function buildDigestWithEntries(
  sub: {
    preferences: {
      languages?: unknown;
      keywords?: unknown;
      digestCount?: unknown;
    };
  },
  now: Date = new Date(),
): Promise<{ content: string; entries: { fullName: string }[] }> {
  const { languages, keywords, digestCount } = normalizePreferences(
    sub.preferences,
  );
  const pool = await fetchTopEntries(languages);
  const shownEntries = rankByPreferences(pool, keywords).slice(0, digestCount);
  const summaries = await loadSummariesSafe(shownEntries);
  const lines = shownEntries.map((entry, index) =>
    formatEntryLine(index + 1, entry, summaries.get(entry.fullName)),
  );
  const { text, keptCount } = assemble(headerLine(shanghaiToday(now)), lines);
  return {
    content: text,
    entries: shownEntries
      .slice(0, keptCount)
      .map((entry) => ({ fullName: entry.fullName })),
  };
}

/**
 * 构建单个订阅者的每日简报文本（Task 2/6 消费的薄封装，只返回 content）。
 */
export async function buildDigestForSubscriber(
  sub: {
    preferences: {
      languages?: unknown;
      keywords?: unknown;
      digestCount?: unknown;
    };
  },
  now: Date = new Date(),
): Promise<string> {
  const { content } = await buildDigestWithEntries(sub, now);
  return content;
}

/**
 * 把简报实际展示的条目按 search.ts 同语义覆盖写入 search_caches
 * （先 delete 该用户全部行，再 insert 一行；每用户至多一行）。
 * 空列表不写——绝不让空榜清掉用户上一次有效缓存。
 */
export async function saveRecentResults(
  wecomUserid: string,
  items: { fullName: string }[],
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const database = db();
  await database
    .delete(searchCaches)
    .where(eq(searchCaches.wecomUserid, wecomUserid));
  await database
    .insert(searchCaches)
    .values({ wecomUserid, results: items });
}

/**
 * 失效该用户 search_caches 行（best-effort 兜底，可能 reject，由调用方吞掉）。
 * saveRecentResults 失败后调用：delete 步骤失败时旧行原样残留（insert 未执行），
 * 「收藏 N」会引用用户没收到的旧列表——失效后落回「无缓存」三态引导文案。
 * （若 delete 成功而 insert 失败，本就没有行，失效是幂等的。）
 */
export async function invalidateRecentResults(
  wecomUserid: string,
): Promise<void> {
  await db()
    .delete(searchCaches)
    .where(eq(searchCaches.wecomUserid, wecomUserid));
}

/**
 * 向所有 active 订阅者推送每日简报（markdown 通道）。
 * 逐个 try/catch：单个订阅者失败（建简报或发送）不影响其余，
 * 返回 { sent, failed } 计数。
 * 发送成功后按消息展示顺序写 search_caches（「收藏 N」引用刚收到的简报）；
 * 发送失败不写缓存——绝不让序号指向用户没收到的列表。
 */
export async function pushDigests(
  now: Date = new Date(),
): Promise<{ sent: number; failed: number }> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.active, true));

  let sent = 0;
  let failed = 0;
  for (const sub of rows) {
    try {
      const { content, entries } = await buildDigestWithEntries(sub, now);
      await sendWeComMarkdown(sub.wecomUserid, content);
      sent += 1;
      try {
        await saveRecentResults(sub.wecomUserid, entries);
      } catch (err) {
        // 写缓存失败 → 失效旧缓存，让「收藏 N」落回无缓存三态文案；
        // 失效本身失败仅记日志（DB 全挂时不能外抛、不能翻转发送计数）。
        console.error(`saveRecentResults failed for ${sub.wecomUserid}:`, err);
        try {
          await invalidateRecentResults(sub.wecomUserid);
        } catch (invalidateErr) {
          console.error(
            `invalidateRecentResults failed for ${sub.wecomUserid}:`,
            invalidateErr,
          );
        }
      }
    } catch (err) {
      failed += 1;
      console.error(`pushDigests failed for ${sub.wecomUserid}:`, err);
    }
  }
  return { sent, failed };
}
