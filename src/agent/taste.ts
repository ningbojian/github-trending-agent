import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { favorites, kvCache, repos } from '../db/schema.js';
import { normalizeRepoName } from './repo-name.js';

/**
 * 口味信号：用户「想看什么」的唯一两个来源。
 *
 *   1. 收藏（自动）——收藏过哪些仓库，join repos 就有语言与话题，不需要新存储；
 *   2. 感兴趣 / 不感兴趣（显式）——看完简报回一个词，作用于刚收到的那一批。
 *
 * 没有第三种来源，也不做隐式推断：用户看一眼就能明白它为什么这么排。
 * 全部状态写 kv_cache（不建表）：迁移 0004 会被 journal 时间戳静默跳过，
 * 见 docs/deploy.md 第 1 节。
 */

/** 简报候选：排序只需要语言与话题。 */
export interface DigestCandidate {
  fullName: string;
  language: string | null;
  topics: string[];
}

/** 用户画像。 */
export interface UserSignals {
  /** 已收藏：不再出现在简报里（用户已经知道了）。 */
  starred: Set<string>;
  /** 正数靠前；键一律小写语言名。 */
  languageBoost: Map<string, number>;
  topicBoost: Map<string, number>;
  /** 被「不感兴趣」压到阈值的语言，推送时直接丢。 */
  suppressed: Set<string>;
}

/** 收藏行：repos 里查不到时 language/topics 为 null。 */
export interface StarRow {
  fullName: string;
  language: string | null;
  topics: unknown;
}

export type FeedbackKind = 'like' | 'dislike';

export interface FeedbackEvent {
  at: string;
  kind: FeedbackKind;
  languages: string[];
  topics: string[];
}

/** 同一语言收藏 ≥2 个才算偏好（单个收藏是偶然）。 */
export const STAR_MIN_SIGNAL = 2;
/** 收藏带来的 boost 上限（收藏 10 个 Go 也不至于压死一切）。 */
export const STAR_MAX_BOOST = 3;
/** 收藏话题的 boost 上限。 */
export const STAR_MAX_TOPIC_BOOST = 2;
/** 只看最近 10 次反馈，旧信号自然滚出窗口。 */
export const FEEDBACK_MAX_EVENTS = 10;
/** 180 天：半年没提过就当作忘了。 */
export const FEEDBACK_TTL_MS = 180 * 24 * 3600 * 1000;
/** 一次反馈最多影响 2 门语言 / 3 个话题（防止一句话砍掉整份简报）。 */
export const FEEDBACK_MAX_LANGUAGES = 2;
export const FEEDBACK_MAX_TOPICS = 3;
/** 语言权重夹在 ±3，话题夹在 ±2。 */
export const FEEDBACK_MAX_LANGUAGE_WEIGHT = 3;
export const FEEDBACK_MAX_TOPIC_WEIGHT = 2;
/** 语言权重到 -2 才算「不看这个方向」。 */
export const LANGUAGE_SUPPRESS_AT = -2;

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function topicList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/** 按次数取前 N；并列按名字排序，保证同一批永远给出同一结果。 */
function topN(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name]) => name);
}

export function emptySignals(): UserSignals {
  return {
    starred: new Set(),
    languageBoost: new Map(),
    topicBoost: new Map(),
    suppressed: new Set(),
  };
}

/**
 * 这一批简报里的主方向。
 *
 * 本轮的关键防呆：一次「不感兴趣」只影响最多的 2 门语言 / 3 个话题，
 * 不会因为某天随手一句就把整份简报的方向砍掉。
 */
export function dominantSignals(items: DigestCandidate[]): {
  languages: string[];
  topics: string[];
} {
  const languages = new Map<string, number>();
  const topics = new Map<string, number>();
  for (const item of items) {
    const language = normalize(item.language);
    if (language) bump(languages, language);
    for (const topic of item.topics) {
      const name = normalize(topic);
      if (name) bump(topics, name);
    }
  }
  return {
    languages: topN(languages, FEEDBACK_MAX_LANGUAGES),
    topics: topN(topics, FEEDBACK_MAX_TOPICS),
  };
}

/** 反馈窗口里的原始权重：like +1 / dislike −1，逐事件累加后夹住。 */
export function feedbackWeights(events: FeedbackEvent[]): {
  languages: Map<string, number>;
  topics: Map<string, number>;
} {
  const languages = new Map<string, number>();
  const topics = new Map<string, number>();
  for (const event of events) {
    const delta = event.kind === 'like' ? 1 : -1;
    for (const language of event.languages) {
      const name = normalize(language);
      if (name) bump(languages, name, delta);
    }
    for (const topic of event.topics) {
      const name = normalize(topic);
      if (name) bump(topics, name, delta);
    }
  }
  for (const [name, weight] of languages) {
    languages.set(name, clamp(weight, -FEEDBACK_MAX_LANGUAGE_WEIGHT, FEEDBACK_MAX_LANGUAGE_WEIGHT));
  }
  for (const [name, weight] of topics) {
    topics.set(name, clamp(weight, -FEEDBACK_MAX_TOPIC_WEIGHT, FEEDBACK_MAX_TOPIC_WEIGHT));
  }
  return { languages, topics };
}

/**
 * 收藏 + 反馈合成一份画像（纯函数，好测）。
 *
 * 收藏只有达到 STAR_MIN_SIGNAL 才建立偏好；反馈只要非零就记录下来，
 * 所以「收藏 2 个 Go 之后又两次不感兴趣」会归零而不是消失——归零时
 * 保留这个键，是为了让「抵消」这件事本身可见，而不是悄悄回到默认。
 */
export function composeSignals(rows: StarRow[], events: FeedbackEvent[]): UserSignals {
  const signals = emptySignals();
  const starLanguages = new Map<string, number>();
  const starTopics = new Map<string, number>();

  for (const row of rows) {
    // 一律归一成小写：比较端（digest / digest-filter / push-history）也用同一个函数。
    signals.starred.add(normalizeRepoName(row.fullName));
    const language = normalize(row.language);
    if (language) bump(starLanguages, language);
    for (const topic of topicList(row.topics)) {
      const name = normalize(topic);
      if (name) bump(starTopics, name);
    }
  }

  const feedback = feedbackWeights(events);

  for (const [language, count] of starLanguages) {
    const starBoost = clamp(count, 0, STAR_MAX_BOOST);
    const weight = feedback.languages.get(language) ?? 0;
    if (count >= STAR_MIN_SIGNAL || weight !== 0) {
      signals.languageBoost.set(language, starBoost + weight);
    }
  }
  for (const [language, weight] of feedback.languages) {
    if (!signals.languageBoost.has(language)) {
      signals.languageBoost.set(language, weight);
    }
  }
  for (const [language, weight] of signals.languageBoost) {
    if (weight <= LANGUAGE_SUPPRESS_AT) signals.suppressed.add(language);
  }

  for (const [topic, count] of starTopics) {
    const starBoost = clamp(count, 0, STAR_MAX_TOPIC_BOOST);
    const weight = feedback.topics.get(topic) ?? 0;
    if (starBoost !== 0 || weight !== 0) {
      signals.topicBoost.set(topic, starBoost + weight);
    }
  }
  for (const [topic, weight] of feedback.topics) {
    if (!signals.topicBoost.has(topic)) {
      signals.topicBoost.set(topic, weight);
    }
  }

  return signals;
}

function feedbackKey(userid: string): string {
  return `taste:${userid}`;
}

function parseEvent(value: unknown): FeedbackEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'like' && raw.kind !== 'dislike') return null;
  if (typeof raw.at !== 'string') return null;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((t): t is string => typeof t === 'string') : [];
  return {
    at: raw.at,
    kind: raw.kind,
    languages: strings(raw.languages).map(normalize).filter(Boolean),
    topics: strings(raw.topics).map(normalize).filter(Boolean),
  };
}

/**
 * 读反馈窗口。读不到（坏值 / 超期 / DB 出错）一律 `[]`：
 * 画像读不到就不能把推送弄挂。
 */
export async function readFeedback(userid: string, now: Date = new Date()): Promise<FeedbackEvent[]> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, feedbackKey(userid)))
      .limit(1);
    const row = rows[0];
    if (!row) return [];
    if (row.expiresAt.getTime() <= now.getTime()) return [];
    const value = row.value as { events?: unknown } | null;
    if (typeof value !== 'object' || value === null || !Array.isArray(value.events)) return [];
    return value.events.map(parseEvent).filter((event): event is FeedbackEvent => event !== null);
  } catch (err) {
    console.error('[taste] read failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * 记一次反馈并返回本次影响的方向。
 *
 * 与其它日志不同，**写失败要抛**：这是用户可见的指令，回执不能谎称
 * 「记下了」。调用方负责改成「⚠️ 没记住」。
 */
export async function recordFeedback(
  userid: string,
  kind: FeedbackKind,
  items: DigestCandidate[],
  now: Date = new Date(),
): Promise<{ languages: string[]; topics: string[] }> {
  const affected = dominantSignals(items);
  const previous = await readFeedback(userid, now);
  const event: FeedbackEvent = {
    at: now.toISOString(),
    kind,
    languages: affected.languages,
    topics: affected.topics,
  };
  const events = [...previous, event].slice(-FEEDBACK_MAX_EVENTS);
  await db()
    .insert(kvCache)
    .values({
      key: feedbackKey(userid),
      value: { events },
      expiresAt: new Date(now.getTime() + FEEDBACK_TTL_MS),
    })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
    });
  return affected;
}

/**
 * 读收藏行并 join repos。**不吞异常**：推送路径靠它区分「空画像」与「读不到」。
 * join 用 lower() 两边归一——repo 名大小写不敏感，而 favorites 里存的是
 * 当时用户看到的那份写法。
 */
async function readStarRows(userid: string): Promise<StarRow[]> {
  return db()
    .select({
      fullName: favorites.fullName,
      language: repos.language,
      topics: repos.topics,
    })
    .from(favorites)
    .leftJoin(
      repos,
      sql`lower(${repos.fullName}) = lower(${favorites.fullName})`,
    )
    .where(eq(favorites.wecomUserid, userid));
}

/**
 * 收藏画像 + 反馈窗口。收藏查不到就只用反馈，仍不抛。
 * 适合「读不到也要继续」的场景（我的订阅、排序）。
 */
export async function loadUserSignals(
  userid: string,
  now: Date = new Date(),
): Promise<UserSignals> {
  let rows: StarRow[] = [];
  try {
    rows = await readStarRows(userid);
  } catch (err) {
    console.error('[taste] profile failed:', err instanceof Error ? err.message : err);
  }
  const events = await readFeedback(userid, now);
  return composeSignals(rows, events);
}

/**
 * 严格版：画像读不到就抛。
 *
 * 推送路径专用——读不到收藏就不可能知道哪些不该推，此时宁可不发、
 * 下一个整点重试，也不要发一份没过滤的简报。反馈窗口仍按 fail-open 处理，
 * 因为它只影响排序，不影响「别再推」。
 */
export async function loadUserSignalsStrict(
  userid: string,
  now: Date = new Date(),
): Promise<UserSignals> {
  const rows = await readStarRows(userid);
  const events = await readFeedback(userid, now);
  return composeSignals(rows, events);
}

/** 一条候选的偏好权重；话题贡献最多 ±2，防话题多的条目通吃。 */
export function tasteWeight(item: DigestCandidate, signals: UserSignals): number {
  const language = normalize(item.language);
  const languageWeight = language ? (signals.languageBoost.get(language) ?? 0) : 0;
  let topicWeight = 0;
  for (const topic of item.topics) {
    const name = normalize(topic);
    if (name) topicWeight += signals.topicBoost.get(name) ?? 0;
  }
  return languageWeight + clamp(topicWeight, -FEEDBACK_MAX_TOPIC_WEIGHT, FEEDBACK_MAX_TOPIC_WEIGHT);
}

/** 稳定排序：权重相同保持原顺序（原顺序已是 stars_delta DESC），不丢条目。 */
export function rankByTaste<T extends DigestCandidate>(items: T[], signals: UserSignals): T[] {
  return items
    .map((item, index) => ({ item, index, weight: tasteWeight(item, signals) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.item);
}
