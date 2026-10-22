import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { repos, subscribers, trendingEntries } from '../db/schema';
import { sendWeComText } from '../wecom/api';
import { generateObjectSafe } from './llm';

/**
 * 每日简报：按订阅者偏好取近 7 天 top10 热榜条目，LLM 为每条生成一句
 * 中文「为什么上榜」（新上榜 vs 持续霸榜）；LLM 任何失败都降级为纯模板，
 * repo 列表永远存在。
 *
 * 数据获取不复用 searchTrending：后者会覆盖写 search_caches
 * （用户「最近一次检索」缓存），每日定时任务不该污染该状态，
 * 因此在本模块用 drizzle 直接查询。
 */

/** 简报榜单周期：近 7 天（周榜）。 */
const PERIOD_DAYS = 7;
/** 候选池大小：关键词轻量排序后取前 TOP_N 条。 */
const POOL_SIZE = 20;
/** 简报条数。 */
const TOP_N = 10;
/** 企微文本 ~2048 字节上限的安全阈值（与 Task 9 检索回复一致）。 */
const MAX_DIGEST_BYTES = 1800;
/** 「为什么上榜」最大字数（超出截断，避免撑爆字节上限）。 */
const MAX_WHY_CHARS = 60;
/** 截断标注。 */
const TRUNCATION_NOTE = '（内容过长，已截断）';
/** 榜单为空时的占位文案。 */
const EMPTY_NOTICE = '今日暂无符合条件的热榜项目。';

/** 简报单条：join 后的仓库 + 热榜快照字段。 */
interface DigestEntry {
  fullName: string;
  description: string | null;
  topics: string[];
  stars: number;
  starsDelta: number;
  isNew: boolean;
}

/** LLM「为什么上榜」输出契约：与输入条目按 fullName 对齐。 */
const DigestReasonsSchema = z.object({
  reasons: z.array(
    z.object({
      fullName: z.string(),
      why: z.string(),
    }),
  ),
});

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 简报头部日期：UTC（Vercel 运行时为 UTC）。 */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function headerLine(date: string): string {
  return `📊 今日 GitHub 热榜简报（${date}）`;
}

/**
 * 组装 topN 查询 SQL（trending_entries join repos）。
 * - 近 7 天窗口：`date >= now() - make_interval(days => 7)`
 * - languages 非空：`language IN (...)`（参数化）；空 → 不过滤（全量榜）
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
    conditions.push(sql`${trendingEntries.language} in (${languageValues})`);
  }

  return sql`
    select * from (
      select distinct on (${trendingEntries.fullName})
        ${trendingEntries.fullName} as ${sql.identifier('fullName')},
        ${repos.description} as ${sql.identifier('description')},
        ${repos.topics} as ${sql.identifier('topics')},
        ${repos.stars} as ${sql.identifier('stars')},
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

  // SQL 已 distinct on (full_name)；此处再按 full_name 兜底去重（与 Task 9 一致）。
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

function buildWhyPrompt(date: string, entries: DigestEntry[]): string {
  return [
    '你是 GitHub Trending 每日简报的编辑。为下面每个仓库写一句中文「为什么上榜」。',
    '规则：',
    '- 每条一句，不超过 40 字，语气简洁专业。',
    '- is_new=true 的仓库：从「新上榜」角度说明（首次进入热榜）。',
    '- 其余仓库：从「持续霸榜」角度说明，可引用本周 star 增量 starsDelta。',
    '- 只依据给出的数据，禁止编造任何信息。',
    '- 输出 JSON：{"reasons":[{"fullName":"...","why":"..."}]}，每个仓库恰好一条，顺序一致。',
    '',
    `日期：${date}`,
    ...entries.map(
      (entry, index) =>
        `${index + 1}. ${entry.fullName} ★${entry.stars} (+${entry.starsDelta}) is_new=${entry.isNew}`,
    ),
  ].join('\n');
}

/**
 * 调 LLM 生成「为什么上榜」，按 fullName 映射。
 * generateObjectSafe 契约是失败返回 null；此处再兜一层 try/catch，
 * 保证 LLM 任何异常都只降级（返回已收集的映射），绝不影响 repo 列表。
 */
async function generateWhys(
  date: string,
  entries: DigestEntry[],
): Promise<Map<string, string>> {
  const whys = new Map<string, string>();
  if (entries.length === 0) {
    return whys;
  }
  try {
    const result = await generateObjectSafe(
      DigestReasonsSchema,
      buildWhyPrompt(date, entries),
    );
    if (result === null) {
      return whys;
    }
    for (const item of result.reasons) {
      const why = item.why.trim();
      if (why.length > 0) {
        whys.set(item.fullName, why);
      }
    }
  } catch {
    // LLM 任何异常 → 模板降级，repo 列表照常输出。
  }
  return whys;
}

function clampWhy(why: string): string {
  return why.length > MAX_WHY_CHARS ? `${why.slice(0, MAX_WHY_CHARS)}…` : why;
}

/** 每条两行：列表行 +（可选）「为什么上榜」行。 */
function buildBlocks(
  entries: DigestEntry[],
  whys: Map<string, string>,
): string[] {
  return entries.map((entry, index) => {
    let block = `${index + 1}. ${entry.fullName} ★${entry.stars} (+${entry.starsDelta})`;
    if (entry.isNew) {
      block += '（新上榜）';
    }
    const why = whys.get(entry.fullName);
    if (why !== undefined) {
      block += `\n   为什么上榜：${clampWhy(why)}`;
    }
    return block;
  });
}

/**
 * 头部 + 列表拼接；超过字节上限时从尾部逐条丢弃并标注截断。
 * 单条仍超限（理论上不可达）时只保留首条列表行。
 */
function assemble(header: string, blocks: string[]): string {
  if (blocks.length === 0) {
    return `${header}\n\n${EMPTY_NOTICE}`;
  }
  const full = `${header}\n\n${blocks.join('\n')}`;
  if (byteLength(full) <= MAX_DIGEST_BYTES) {
    return full;
  }
  let kept = blocks;
  while (kept.length > 1) {
    kept = kept.slice(0, -1);
    const candidate = `${header}\n\n${kept.join('\n')}\n${TRUNCATION_NOTE}`;
    if (byteLength(candidate) <= MAX_DIGEST_BYTES) {
      return candidate;
    }
  }
  const firstLine = (kept[0] ?? '').split('\n')[0] ?? '';
  return `${header}\n\n${firstLine}\n${TRUNCATION_NOTE}`;
}

/** preferences 运行时防御：字段缺失/非数组一律按空处理（languages 空 → 全量）。 */
function normalizePreferences(preferences: {
  languages?: unknown;
  keywords?: unknown;
}): { languages: string[]; keywords: string[] } {
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : [];
  return {
    languages: list(preferences.languages),
    keywords: list(preferences.keywords),
  };
}

/**
 * 构建单个订阅者的每日简报文本（全中文文案）。
 * - preferences.languages 为空/缺失 → 全量语言榜；非空 → language IN 过滤
 * - keywords 轻量提升排序（不丢弃条目）
 * - top10，每条可带一句 LLM 生成的「为什么上榜」
 * - LLM 失败（null 或抛错）→ 纯模板降级，repo 列表始终存在
 */
export async function buildDigestForSubscriber(sub: {
  preferences: { languages?: unknown; keywords?: unknown };
}): Promise<string> {
  const { languages, keywords } = normalizePreferences(sub.preferences);
  const pool = await fetchTopEntries(languages);
  const entries = rankByPreferences(pool, keywords).slice(0, TOP_N);
  const date = utcToday();
  const whys = await generateWhys(date, entries);
  return assemble(headerLine(date), buildBlocks(entries, whys));
}

/**
 * 向所有 active 订阅者推送每日简报。
 * 逐个 try/catch：单个订阅者失败（建简报或发送）不影响其余，
 * 返回 { sent, failed } 计数。
 */
export async function pushDigests(): Promise<{ sent: number; failed: number }> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.active, true));

  let sent = 0;
  let failed = 0;
  for (const sub of rows) {
    try {
      const digest = await buildDigestForSubscriber(sub);
      await sendWeComText(sub.wecomUserid, digest);
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`pushDigests failed for ${sub.wecomUserid}:`, err);
    }
  }
  return { sent, failed };
}
