import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { repos, searchCaches, subscribers, trendingEntries } from '../db/schema.js';
import { loadStarredNames } from '../github/starred-names.js';
import { note, traceError, withTrace } from '../obs/trace.js';
import { sendWeComText } from '../wecom/api.js';
import { formatEntryLine } from '../wecom/text.js';
import { loadAbstractSafe } from './abstract.js';
import { applyHardFilters, passesGrowth } from './digest-filter.js';
import {
  getDailySnapshot,
  selectEntriesForPreferences,
  type DigestSnapshot,
  type DigestSnapshotItem,
} from './digest-snapshot.js';
import {
  pushedRecently,
  readPushHistory,
  recordPush,
} from './push-history.js';
import { normalizePreferences } from './preferences.js';
import { loadRepoSummaries } from './repo-summary.js';
import { normalizeRepoName } from './repo-name.js';
import { loadUserSignalsStrict, rankByTaste, type UserSignals } from './taste.js';
import { calendarDaysBetween, shanghaiHHMM, shanghaiMinutes, shanghaiToday } from './time.js';

/**
 * 偏好常量与规范化函数已迁到 preferences.ts（读取侧与「我的订阅」展示侧共用）。
 * 仍从本模块转出：老调用方（onboarding / 测试）不需要改导入路径。
 */
export {
  DEFAULT_DIGEST_COUNT,
  DEFAULT_PUSH_TIME,
  MAX_DIGEST_COUNT,
  MAX_INTERVAL_DAYS,
  MIN_DIGEST_COUNT,
  MIN_INTERVAL_DAYS,
  normalizePreferences,
} from './preferences.js';

export { calendarDaysBetween, shanghaiHHMM, shanghaiMinutes, shanghaiToday } from './time.js';

/**
 * 每日简报：按订阅者偏好取近 7 天 topN 热榜条目，每条一行
 * （仓库可点链接 + 中文简介），走企微文本消息推送。
 * 简介经 loadRepoSummaries（Task 1）批量生成 + 全局 kv 缓存，失败自动降级，
 * repo 列表永远存在。
 *
 * 数据获取不复用 searchTrending：后者按"用户最近一次检索"的语义写 search_caches，
 * 每日定时任务不该借用那条通道；推送成功后本模块用 saveRecentResults 按
 * **消息实际展示的顺序**（含 digestCount 与 1900 字节截断）覆盖写 search_caches，
 * 让用户收到简报后直接「收藏 N」即可引用其中条目；用户随后搜索会正常覆盖。
 */

/** 简报榜单周期：近 7 天（周榜）。 */
const PERIOD_DAYS = 7;
/** 候选池大小：关键词轻量排序后取前 N 条。 */
const POOL_SIZE = 20;
/** 企微文本消息 2048 字节上限的安全阈值（与搜索回复一致）。 */
const MAX_DIGEST_BYTES = 1900;
/** 截断标注。 */
const TRUNCATION_NOTE = '（内容过长，已截断）';
/** 榜单为空时的占位文案。 */
const EMPTY_NOTICE = '今日暂无符合条件的热榜项目。';
/** 简报页脚：用具体例子教「序号精确反馈」（用户不会自己想到可以带序号）。 */
export const DIGEST_FOOTER =
  '💡 「收藏 3」收藏第 3 条；「不感兴趣 3」只针对它；「我的订阅」看设置；「帮助」看全部';

/** 连续这么多天没有值得推的项目时，补一句「还在，只是没新东西」。 */
export const QUIET_NOTE_AFTER_DAYS = 3;

const DAY_MS = 24 * 3600 * 1000;

/**
 * 静默补助：沉默是正确的，但要能被理解成「今天没新东西」而不是「坏了」。
 * 被「不感兴趣」屏蔽时点名原因；设置了语言偏好时说明当前只看哪些。
 */
export function quietNote(languages: string[], suppressedHit: string[]): string {
  let text = '最近没有明显增长的新项目，有值得看的会第一时间推给你。';
  if (suppressedHit.length > 0) {
    text += `（已按你的「不感兴趣」屏蔽 ${suppressedHit.join('、')}）`;
  } else if (languages.length > 0) {
    text += `（当前只看 ${languages.join('/')}，发「订阅 …」可调整）`;
  }
  return text;
}

/** 简报单条：join 后的仓库 + 热榜快照字段。 */
interface DigestEntry {
  fullName: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stars: number;
  starsDelta: number;
  isNew: boolean;
  htmlUrl: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
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
        ${repos.language} as ${sql.identifier('language')},
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
      language: row.language == null ? null : String(row.language),
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
 * 头部 + 单行列表 + 页脚拼接；超过 1900 字节时从尾部逐条丢弃并标注截断。
 * 空列表只回占位文案（无可收藏条目，不带收藏页脚）。
 * 返回 keptCount：最终消息里实际展示的条目数（供 entries 与缓存对齐）。
 */
function assemble(
  header: string,
  lines: string[],
  intro?: string | null,
): { text: string; keptCount: number } {
  if (lines.length === 0) {
    const parts = [header];
    if (intro) {
      parts.push('', intro);
    }
    parts.push('', EMPTY_NOTICE);
    return { text: parts.join('\n'), keptCount: 0 };
  }
  const build = (kept: string[], truncated: boolean): string => {
    const parts = [header];
    if (intro) {
      parts.push('', intro);
    }
    parts.push('', ...kept);
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
  // 理论不可达：截断标注 + 页脚本身远小于 1900 字节。
  return { text: build([], true), keptCount: 0 };
}

/**
 * 构建单个订阅者的每日简报文本 + 消息里实际展示的可收藏条目
 * （全中文文案，纯文本单行 + 裸链接 + 中文简介）。
 * - preferences.languages 为空/缺失 → 全量语言榜；非空（已小写化）→ lower(repos.language) IN 过滤
 * - keywords 轻量提升排序（不丢弃条目）
 * - 条数按 preferences.digestCount（clamp 1–20，默认 10）
 * - 头部日期按北京时间（now 可注入，供测试与 Task 5 复用）
 * - 简介失败（null/抛错/缓存未命中降级）→ 无破折号后段，repo 列表始终存在
 * - entries 顺序 = 消息行顺序（排序 + digestCount 截断 + 1900 字节截断之后）；
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
  accept?: (entry: DigestEntry) => boolean,
): Promise<{ content: string; entries: { fullName: string }[] }> {
  const { languages, keywords, digestCount } = normalizePreferences(
    sub.preferences,
  );
  const pool = await fetchTopEntries(languages);
  const ranked = rankByPreferences(pool, keywords);
  const shownEntries = (accept === undefined ? ranked : ranked.filter(accept)).slice(
    0,
    digestCount,
  );
  const summaries = await loadSummariesSafe(shownEntries);
  const lines = shownEntries.map((entry, index) =>
    formatEntryLine(index + 1, entry, summaries.get(entry.fullName)),
  );
  // 与快照路径同口径的开头概览：只在真正有列表时生成，失败为 null（简报照常发）。
  const intro = await loadAbstractSafe(shownEntries, summaries);
  const { text, keptCount } = assemble(headerLine(shanghaiToday(now)), lines, intro);
  return {
    content: text,
    entries: shownEntries
      .slice(0, keptCount)
      .map((entry) => ({ fullName: entry.fullName })),
  };
}

/**
 * 从当日快照构建单个订阅者的简报（企微渠道）：
 * - 选择层与邮件共用 selectEntriesForPreferences（语言过滤 + 关键词排序 + 条数）
 * - Abstract 作为开头概览（快照构建失败时省略，格式与既有简报一致）
 * - 仍走 assemble 的 1900 字节截断；entries 与消息实际展示顺序对齐
 */
export async function buildDigestFromSnapshot(
  sub: {
    preferences: {
      languages?: unknown;
      keywords?: unknown;
      digestCount?: unknown;
    };
  },
  snapshot: DigestSnapshot,
  accept?: (item: DigestSnapshotItem) => boolean,
): Promise<{ content: string; entries: { fullName: string }[] }> {
  const { languages, keywords, digestCount } = normalizePreferences(
    sub.preferences,
  );
  const selected = selectEntriesForPreferences(
    snapshot.items,
    {
      languages,
      keywords,
      digestCount,
    },
    10,
    accept,
  );
  const lines = selected.map((item, index) =>
    formatEntryLine(index + 1, item, item.summary),
  );
  const { text, keptCount } = assemble(
    headerLine(snapshot.date),
    lines,
    snapshot.abstract,
  );
  return {
    content: text,
    entries: selected
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
 * pushDigests 返回值：sent=实际发送；skipped=门控未到/当日已发/未满间隔/抢占
 * 落败（含并发竞争）；failed=抢占成功后构建或发送失败（已回滚，下一小时重试）。
 */
export interface PushDigestsResult {
  sent: number;
  skipped: number;
  failed: number;
}

export interface PushDigestsOptions {
  /**
   * 整轮推送的时间预算（毫秒）。默认 240 秒：函数上限是 300 秒，
   * 留出快照构建、周复盘与收尾的余量。
   */
  budgetMs?: number;
  /** 注入时钟（单测用）。 */
  clock?: () => number;
}

/** 默认 240 秒：给 maxDuration=300 留 60 秒余量。 */
export const PUSH_BUDGET_MS = 240_000;

/** 「HH:MM」→ 当日分钟数（pushTime 已经过 PUSH_TIME_RE 校验）。 */
function pushTimeMinutes(pushTime: string): number {
  const [hour, minute] = pushTime.split(':');
  return Number(hour) * 60 + Number(minute);
}

/**
 * 该订阅者今日是否可发（JS 侧门控，与抢占 SQL 的条件同语义）：
 * - 从未发送（last_digest_at 为 null）→ 可发；
 * - 上次发送的北京日期在「今天」或之后（当天已发/时钟偏移的未来时间）→ 不可发；
 * - 否则要求**北京日期差 >= intervalDays**。
 *
 * 间隔按日历日而不是精确 24 小时：claim 写入的是实际发送时刻，若再要求满
 * 24 小时，一次 tick 延迟（GitHub Actions 的每小时 cron 实测会晚十几分钟）
 * 就会让次日同一时刻差几分钟被跳过，实际推送时间从此永久后移。
 * 抢占 SQL 仍是并发下的权威（两进程同时读到 null 时只有一方能 UPDATE 成功）。
 */
function eligibleForPush(
  lastDigestAt: Date | null,
  intervalDays: number,
  today: string,
): boolean {
  if (lastDigestAt === null) {
    return true;
  }
  const lastDay = shanghaiToday(lastDigestAt);
  if (lastDay >= today) {
    return false;
  }
  return calendarDaysBetween(lastDay, today) >= intervalDays;
}

/**
 * 条件 UPDATE 抢占（原子，防并发重复发送）：
 * `SET last_digest_at = now() WHERE id=$1 AND active AND
 *  (last_digest_at IS NULL OR (北京日期 < 今日 AND 北京日期差 >= intervalDays))`
 * 返回 true=抢到（可以构建发送）；false=已发过/并发对方先抢到。
 * 日期比较用 AT TIME ZONE 'Asia/Shanghai'——last_digest_at 是 timestamptz，
 * 转北京时间墙钟再取 date 才是用户的「今天」；date - date 得整数天，
 * 与 JS 侧 `calendarDaysBetween` 同语义（不是 now() - interval）。
 */
async function claimDigest(id: number, intervalDays: number): Promise<boolean> {
  const condition = and(
    eq(subscribers.id, id),
    eq(subscribers.active, true),
    or(
      isNull(subscribers.lastDigestAt),
      and(
        sql`(${subscribers.lastDigestAt} AT TIME ZONE 'Asia/Shanghai')::date < (now() AT TIME ZONE 'Asia/Shanghai')::date`,
        sql`((now() AT TIME ZONE 'Asia/Shanghai')::date - (${subscribers.lastDigestAt} AT TIME ZONE 'Asia/Shanghai')::date) >= ${intervalDays}`,
      ),
    ),
  ) as SQL;
  const rows = await db()
    .update(subscribers)
    .set({ lastDigestAt: sql`now()` })
    .where(condition)
    .returning({ id: subscribers.id });
  return rows.length > 0;
}

/**
 * 抢占成功后的失败回滚：把 last_digest_at 置回 NULL，让下一小时的整点
 * tick 重新满足抢占条件（重试）。回滚自身失败仅记日志——绝不向外抛。
 */
async function rollbackClaim(id: number): Promise<void> {
  try {
    await db()
      .update(subscribers)
      .set({ lastDigestAt: null })
      .where(eq(subscribers.id, id));
  } catch (err) {
    console.error(`rollback last_digest_at failed for subscriber ${id}:`, err);
  }
}

/**
 * 首日简报（加入应用时的礼包）发送成功后记为「今日已发」：
 * 让当天的整点 tick 因「北京日期已发」而跳过，避免同一天收到两份简报。
 *
 * 回填的是**北京当日 00:00** 而不是 now()。原因：pushDigests 的间隔门控同时要求
 * `last_digest_at <= now() - intervalDays 天`；若记成 now()（如 14:00），次日 09:00
 * 只过了 19 小时，永远不满足 24h，用户会被永久推到「每天 14:00」（且逐次漂移）。
 * 回填当日 00:00 等价于「今天这个名额已经用掉」，明天起恢复按 pushTime 正常推送
 * （对 intervalDays=N 同样成立：第 N 天的 pushTime 必已满 N×24h）。
 * 定时推送不走此函数（那边用条件 UPDATE 抢占，见 claimDigest）。
 */
export async function markDigestSent(wecomUserid: string): Promise<void> {
  await db()
    .update(subscribers)
    .set({
      lastDigestAt: sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
    })
    .where(eq(subscribers.wecomUserid, wecomUserid));
}

/**
 * 向所有 active 订阅者推送每日简报（文本通道），按 Task 5 门控逐个放行：
 * 1. 北京时间分钟数 `nowMin >= pushMin`（pushTime 非法按 09:00）；
 * 2. 当日未发且已满 intervalDays 天（JS 预检，避免无谓写库）；
 * 3. 条件 UPDATE 抢占（并发权威；落败 → skipped，绝不重复发送）；
 * 4. 抢占成功后构建 → 发送 → 按消息展示顺序写 search_caches。
 * 逐个 try/catch：抢占后的任何失败（构建/发送）把 last_digest_at 回滚为 NULL
 * 并计入 failed，下一小时重试；单个订阅者失败不影响其余。
 * 返回 { sent, skipped, failed }。
 * 发送成功后写 search_caches（「收藏 N」引用刚收到的简报）；
 * 发送失败不写缓存——绝不让序号指向用户没收到的列表。
 */
export async function pushDigests(
  now: Date = new Date(),
  options: PushDigestsOptions = {},
): Promise<PushDigestsResult> {
  const budgetMs = options.budgetMs ?? PUSH_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.active, true));

  // 当日快照只构建/读取一次，两个渠道共用；失败返回 null → 逐订阅者回退。
  const snapshot = await getDailySnapshot(now);

  const nowMinutes = shanghaiMinutes(now);
  const today = shanghaiToday(now);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  for (const sub of rows) {
    // 时间预算：超时后既不再抢占也不再发送，剩下的留给下一个整点。
    // 不做这一步的话，函数会在 maxDuration 处被直接杀掉——已抢占但未发送的
    // 订阅者要等回滚，而排在后面的人整轮都没被看到。
    if (clock() - startedAt > budgetMs) {
      const remaining = rows.length - processed;
      skipped += remaining;
      console.warn(
        `[digest] time budget exceeded (${budgetMs}ms), ${remaining} 位订阅者留到下一个整点`,
      );
      break;
    }
    processed += 1;
    // claimed 只在抢占确认成功后为 true：外层 catch 据此决定是否回滚
    // （抢占语句自身抛错 = 未生效，无需回滚）。
    let claimed = false;
    try {
      const { pushTime, intervalDays } = normalizePreferences(sub.preferences);
      if (nowMinutes < pushTimeMinutes(pushTime)) {
        skipped += 1;
        continue;
      }
      if (!eligibleForPush(sub.lastDigestAt ?? null, intervalDays, today)) {
        skipped += 1;
        continue;
      }
      claimed = await claimDigest(sub.id, intervalDays);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      // 只给真正要发的这次调用建 trace：没到点/间隔未到/抢锁失败的订阅者
      // 每个整点都会跑一遍，全记下来只会把真正有用的记录淹掉。
      await withTrace({ kind: 'push', userid: sub.wecomUserid }, async () => {
      note('digest-source', snapshot ? 'snapshot' : 'rebuild');
      // 严格版：画像读不到就抛，外层 catch 记 failed + 回滚 claim，下个整点重试。
      // 绝不发一份「不知道自己收藏了什么」的简报——那正是用户投诉的那个 bug。
      let signals: UserSignals;
      try {
        signals = await loadUserSignalsStrict(sub.wecomUserid, now);
      } catch (err) {
        note('signals-failed', err instanceof Error ? err.message : String(err));
        throw err;
      }
      // 网页端 star：本地 favorites 没有行，但用户确实收藏过。
      // 只并入「不推」集合，不参与语言加权（否则同一批收藏会被算两遍）。
      const webStars = await loadStarredNames(
        sub.wecomUserid,
        sub.githubTokenEnc ?? null,
        sub.githubLogin ?? null,
        now,
      );
      if (webStars !== null) {
        for (const name of webStars.names) signals.starred.add(name);
        note(
          'github-stars',
          `${webStars.cached ? '缓存' : '拉取'} ${webStars.names.length}`,
        );
      }
      const history = await readPushHistory(sub.wecomUserid, now);
      note(
        'signals',
        `收藏 ${signals.starred.size} / 屏蔽 ${
          signals.suppressed.size > 0 ? [...signals.suppressed].join(',') : '无'
        }`,
      );

      // 同一个谓词，两条路径共用：要么作用在预筛过的 pool 上，要么交给
      // buildDigestWithEntries 逐条判定（退化路径自己查库，拿不到 pool）。
      const accept = (item: {
        fullName: string;
        language: string | null;
        starsDelta: number;
        isNew: boolean;
      }): boolean => {
        const language = (item.language ?? '').trim().toLowerCase();
        return (
          passesGrowth(item) &&
          !signals.starred.has(normalizeRepoName(item.fullName)) &&
          (language === '' || !signals.suppressed.has(language)) &&
          !pushedRecently(history, item.fullName, now)
        );
      };

      let built: { content: string; entries: { fullName: string }[] };
      if (snapshot) {
        const pool = rankByTaste(
          applyHardFilters(snapshot.items, { signals, history, now }),
          signals,
        );
        // 拆成两条：看板可以分别聚合「候选量」与「去重后剩余」，不用解析文案。
        note('dedup-before', String(snapshot.items.length));
        note('dedup-after', String(pool.length));
        built = await buildDigestFromSnapshot(sub, { ...snapshot, items: pool }, accept);
      } else {
        built = await buildDigestWithEntries(sub, now, accept);
      }
      const { content, entries } = built;

      if (entries.length === 0) {
        note('digest-empty', '没有通过硬过滤 + 增长门槛的条目');
        // 静默分支不写 search_caches（「收藏 N」仍指向上一份真实列表），
        // 也不回滚 claim（当天不再每小时重试）。
        const lastSentAt = history?.lastSentAt ?? null;
        const quietDays =
          lastSentAt === null ? null : (now.getTime() - Date.parse(lastSentAt)) / DAY_MS;
        if (
          quietDays !== null &&
          Number.isFinite(quietDays) &&
          quietDays >= QUIET_NOTE_AFTER_DAYS
        ) {
          const { languages } = normalizePreferences(sub.preferences);
          await sendWeComText(
            sub.wecomUserid,
            quietNote(languages, [...signals.suppressed]),
          );
          note('quiet', `距上次 ${Math.floor(quietDays)} 天，补一句`);
          sent += 1;
          await recordPush(sub.wecomUserid, [], now);
        } else {
          note('quiet', '静默（近期已发过或从未发过）');
          skipped += 1;
        }
        return;
      }

      await sendWeComText(sub.wecomUserid, content);
      note('send', `ok ${Buffer.byteLength(content, 'utf8')} 字节`);
      sent += 1;
      await recordPush(
        sub.wecomUserid,
        entries.map((entry) => entry.fullName),
        now,
      );
      try {
        await saveRecentResults(sub.wecomUserid, entries);
      } catch (err) {
        // 写缓存失败 → 失效旧缓存，让「收藏 N」落回无缓存三态文案；
        // 失效本身失败仅记日志（DB 全挂时不能外抛、不能翻转发送计数）。
        // 注意：消息已发出，不触发 last_digest_at 回滚。
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
      });
    } catch (err) {
      failed += 1;
      console.error(`pushDigests failed for ${sub.wecomUserid}:`, err);
      traceError(err);
      if (claimed) {
        await rollbackClaim(sub.id);
      }
    }
  }
  return { sent, skipped, failed };
}
