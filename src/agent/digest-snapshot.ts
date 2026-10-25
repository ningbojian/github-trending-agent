import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { shanghaiToday } from './time.js';
import { generateObjectSafe } from './llm.js';
import { loadRepoSummaries } from './repo-summary.js';

/**
 * 每日快照：一天只构建一次，企微与邮件两个渠道共用（一轮模型）。
 *
 * - 缓存键 `digest-snapshot:<YYYY-MM-DD>`（kv_cache，TTL 24h）。
 * - 候选池：近 7 天去重后，在 SQL 里同时算全局榜与语言榜排名，
 *   保留全局 top 20 + 每个语言榜 top 20（只在全局榜截断会让小语种整榜缺席）。
 * - 缓存带 `dataDate`（候选池里最新一条数据的日期）：每次调用都重跑候选查询，
 *   数据日期变了就重建快照。否则北京 00:00 的第一个 tick 会缓存一份
 *   「昨天数据」的快照，全天所有推送都少一份最新数据。
 * - 中文简介：候选池按每批 ≤40 个仓库调用 loadRepoSummaries
 *   （内部批量 + `repo-zh:<fullName>` 180 天全局缓存），批间失败只丢该批简介。
 * - Abstract：一次小调用，2 句话 ≤80 字；失败则不写 abstract，简报照常发送。
 * - 任何失败返回 null，两个渠道各自回退现有 buildDigestWithEntries。
 */

export interface DigestSnapshotItem {
  fullName: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stars: number;
  starsDelta: number;
  isNew: boolean;
  htmlUrl: string;
  summary?: string;
}

export interface DigestSnapshot {
  date: string;
  /** 候选池里最新一条抓取数据的日期；空池为 null。 */
  dataDate: string | null;
  abstract: string | null;
  items: DigestSnapshotItem[];
}

const CACHE_PREFIX = 'digest-snapshot:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = 7;
/** 全局榜条数。 */
const GLOBAL_TOP = 20;
/** 每个语言榜条数：与订阅者可选的最大条数（20）对齐，避免「要 20 条只给 15 条」。 */
const LANGUAGE_TOP = 20;
/** 简介批量大小（每批一次 LLM）。 */
const SUMMARY_BATCH = 40;
/** Abstract 上限（按码点）。 */
const ABSTRACT_MAX_CHARS = 80;

const abstractSchema = z.object({ abstract: z.string() });

function snapshotKey(date: string): string {
  return `${CACHE_PREFIX}${date}`;
}

interface CandidateRow {
  fullName: unknown;
  description: unknown;
  topics: unknown;
  language: unknown;
  stars: unknown;
  starsDelta: unknown;
  isNew: unknown;
  htmlUrl: unknown;
  dataDate?: unknown;
}

/**
 * 近 7 天候选池：distinct on (full_name) 取组内 stars_delta 最大的一行，
 * 再在 SQL 里同时算全局榜与语言榜排名，只保留
 * 「全局 top 20 或 本语言 top 20」。
 *
 * 不能只按全局 stars_delta 截断：小语种（swift / lua / vue …）整榜会在
 * 截断处消失，语言偏好选了这些小语种的订阅者会收到 0 条。
 * 同时带出 dataDate（候选池里最新一条数据日期）供缓存校验。
 */
export function composeCandidatesSql(): SQL {
  return sql`
    with deduped as (
      select distinct on (${sql.raw('trending_entries.full_name')})
        ${sql.raw('trending_entries.full_name')} as "fullName",
        ${sql.raw('repos.description')} as "description",
        ${sql.raw('repos.topics')} as "topics",
        ${sql.raw('repos.language')} as "language",
        ${sql.raw('repos.stars')} as "stars",
        ${sql.raw('repos.html_url')} as "htmlUrl",
        ${sql.raw('trending_entries.stars_delta')} as "starsDelta",
        ${sql.raw('trending_entries.is_new')} as "isNew",
        ${sql.raw('trending_entries.date')}::text as "entryDate"
      from trending_entries
      join repos on repos.full_name = trending_entries.full_name
      where trending_entries.date >= now() - make_interval(days => ${PERIOD_DAYS})
      order by trending_entries.full_name, trending_entries.stars_delta desc
    ),
    ranked as (
      select
        *,
        row_number() over (order by "starsDelta" desc, "fullName") as global_rank,
        row_number() over (partition by lower("language") order by "starsDelta" desc, "fullName") as language_rank,
        max("entryDate") over () as "dataDate"
      from deduped
    )
    select * from ranked
    where global_rank <= ${GLOBAL_TOP} or language_rank <= ${LANGUAGE_TOP}
    order by "starsDelta" desc, "fullName"
  `;
}

function toItem(row: CandidateRow): DigestSnapshotItem {
  return {
    fullName: String(row.fullName),
    description: row.description == null ? null : String(row.description),
    topics: Array.isArray(row.topics) ? row.topics.map((t) => String(t)) : [],
    language: row.language == null ? null : String(row.language),
    stars: Number(row.stars),
    starsDelta: Number(row.starsDelta),
    isNew: Boolean(row.isNew),
    htmlUrl: row.htmlUrl == null ? '' : String(row.htmlUrl),
  };
}

/**
 * 全局 top 20 + 每个语言榜 top 15（按 stars_delta 降序的顺序在 SQL 里已排好，
 * 这里按出现顺序截取，天然稳定）。按 fullName 去重。
 */
export function selectSnapshotPool(candidates: DigestSnapshotItem[]): DigestSnapshotItem[] {
  const picked: DigestSnapshotItem[] = [];
  const seen = new Set<string>();
  const push = (item: DigestSnapshotItem): void => {
    if (seen.has(item.fullName)) return;
    seen.add(item.fullName);
    picked.push(item);
  };

  for (const item of candidates.slice(0, GLOBAL_TOP)) {
    push(item);
  }
  const perLanguage = new Map<string, number>();
  for (const item of candidates) {
    const language = item.language?.trim().toLowerCase();
    if (!language) continue;
    const count = perLanguage.get(language) ?? 0;
    if (count >= LANGUAGE_TOP) continue;
    perLanguage.set(language, count + 1);
    push(item);
  }
  return picked;
}

function truncateChars(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

function buildAbstractPrompt(items: DigestSnapshotItem[], summaries: Map<string, string>): string {
  const lines = items.map((item) => {
    const zh = summaries.get(item.fullName)?.trim();
    return `- ${item.fullName}${zh ? `：${zh}` : ''}`;
  });
  return [
    '下面是今天 GitHub 热榜的仓库列表。请写 2 句话、不超过 80 个汉字的今日概览：',
    '1. 只概括共同主题或方向，不逐个列举仓库，不编造列表之外的事实；',
    '2. 语气客观中性，不用营销词、不用 emoji；',
    '3. 以 JSON 输出：{"abstract":"..."}。',
    '',
    '仓库列表：',
    ...lines,
  ].join('\n');
}

async function loadAbstractSafe(
  items: DigestSnapshotItem[],
  summaries: Map<string, string>,
): Promise<string | null> {
  try {
    const out = await generateObjectSafe(
      abstractSchema,
      buildAbstractPrompt(items, summaries),
    );
    const text = out?.abstract?.trim();
    if (!text) return null;
    return truncateChars(text, ABSTRACT_MAX_CHARS);
  } catch {
    return null;
  }
}

async function loadSummariesSafe(
  items: DigestSnapshotItem[],
): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  for (let start = 0; start < items.length; start += SUMMARY_BATCH) {
    const batch = items.slice(start, start + SUMMARY_BATCH);
    try {
      const result = await loadRepoSummaries(batch);
      for (const [fullName, zh] of result) {
        merged.set(fullName, zh);
      }
    } catch (err) {
      console.error('snapshot summaries batch failed (degrade to no-summary):', err);
    }
  }
  return merged;
}

function isSnapshot(value: unknown): value is DigestSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DigestSnapshot>;
  if (typeof snapshot.date !== 'string') return false;
  // dataDate 是缓存有效性的一部分：老缓存没有它 → 视为无效并重建。
  if (snapshot.dataDate !== null && typeof snapshot.dataDate !== 'string') return false;
  if (snapshot.abstract !== null && typeof snapshot.abstract !== 'string') return false;
  return Array.isArray(snapshot.items);
}

async function readCache(date: string): Promise<DigestSnapshot | null> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(sql`${kvCache.key} = ${snapshotKey(date)}`);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const value = row.value;
  if (!isSnapshot(value) || value.date !== date) return null;
  return value;
}

async function writeCache(snapshot: DigestSnapshot): Promise<void> {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  await db()
    .insert(kvCache)
    .values({ key: snapshotKey(snapshot.date), value: snapshot, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: snapshot, expiresAt },
    });
}

async function buildSnapshot(
  date: string,
  candidates: DigestSnapshotItem[],
  dataDate: string | null,
): Promise<DigestSnapshot> {
  const items = selectSnapshotPool(candidates);
  const summaries = await loadSummariesSafe(items);
  for (const item of items) {
    const zh = summaries.get(item.fullName);
    if (zh !== undefined) item.summary = zh;
  }
  const abstract = await loadAbstractSafe(items, summaries);
  return { date, dataDate, abstract, items };
}

/**
 * 读取或构建当日快照；任何失败返回 null（调用方回退现有简报构建）。
 * now 可注入供测试。
 *
 * 候选查询每次调用都跑（一条索引查询，成本可忽略），用它的 dataDate 判断
 * 缓存是否还代表「今天已落库的最新数据」：北京 00:00 的 tick 会先缓存一份
 * 昨天数据的快照，08:30 抓取落库后必须重建，否则全天都发旧榜。
 */
export async function getDailySnapshot(
  now: Date = new Date(),
): Promise<DigestSnapshot | null> {
  try {
    const date = shanghaiToday(now);
    const { rows } = await db().execute(composeCandidatesSql());
    const raw = rows as unknown as CandidateRow[];
    const candidates = raw.map(toItem);
    const firstDataDate = raw[0]?.dataDate;
    const dataDate = firstDataDate == null ? null : String(firstDataDate);

    const cached = await readCache(date);
    if (cached && cached.dataDate === dataDate) return cached;

    const snapshot = await buildSnapshot(date, candidates, dataDate);
    if (snapshot.items.length === 0) {
      // 空榜不写缓存：稍后数据补齐时可重新构建。
      return snapshot;
    }
    await writeCache(snapshot);
    return snapshot;
  } catch (err) {
    console.error('getDailySnapshot failed (fallback to buildDigestWithEntries):', err);
    return null;
  }
}

/** 与 digest.ts 同字符集的标点清洗。 */
const KEYWORD_PUNCT_RE = /[。！？!?；;，,、()（）]/g;

function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : [];
}

function normalizeKeywords(value: unknown): string[] {
  // 兼容历史/脏数据里的逗号串（与邮箱 preferences 的清洗口径一致）。
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、]/)
      : [];
  return list
    .map((item) => String(item).replace(KEYWORD_PUNCT_RE, '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeCount(value: unknown, defaultCount: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(20, Math.max(1, Math.floor(value)))
    : defaultCount;
}

function matchesKeyword(item: DigestSnapshotItem, keyword: string): boolean {
  return (
    item.fullName.toLowerCase().includes(keyword) ||
    (item.description ?? '').toLowerCase().includes(keyword) ||
    item.topics.some((topic) => topic.toLowerCase().includes(keyword))
  );
}

/**
 * 纯函数选择层：语言过滤 → 关键词排序（不丢弃条目）→ 按条数截取。
 * 企微与邮件调用同一个函数，没有任何按用户的模型调用。
 */
export function selectEntriesForPreferences(
  items: DigestSnapshotItem[],
  preferences: { languages?: unknown; keywords?: unknown; digestCount?: unknown },
  defaultCount = 10,
): DigestSnapshotItem[] {
  const languages = normalizeList(preferences.languages);
  const keywords = normalizeKeywords(preferences.keywords);
  const digestCount = normalizeCount(preferences.digestCount, defaultCount);

  const filtered =
    languages.length === 0
      ? items
      : items.filter((item) => {
          const language = item.language?.trim().toLowerCase();
          return language !== undefined && language !== '' && languages.includes(language);
        });

  const ranked =
    keywords.length === 0
      ? filtered
      : [...filtered].sort(
          (a, b) =>
            Number(keywords.some((keyword) => matchesKeyword(b, keyword))) -
            Number(keywords.some((keyword) => matchesKeyword(a, keyword))),
        );

  return ranked.slice(0, digestCount);
}
