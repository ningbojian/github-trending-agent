/**
 * 订阅冲突提示：用户订阅了某关键词，却连续几次对同方向说「不感兴趣」。
 *
 * 为什么只提示、不自动改订阅：订阅是用户显式写下的意图，系统替他删词
 * 属于越权。提示一句话、给出精确命令，改不改由用户决定。
 *
 * 约束：
 * - 只有「不感兴趣」累计到 CONFLICT_THRESHOLD 次才提示（一次噪声不算冲突）；
 * - 同一条事件对同一个词只计一次（语言和话题同时命中也不重复计）；
 * - 每个词 30 天内最多提示一次（kv 标记），避免每次反馈都唠叨；
 * - 一次最多提示一个词（计数最高，并列按名字），提示是回执之后的第二条消息。
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { readFeedback, type FeedbackEvent } from './taste.js';
import { readSubscription } from './subscription-store.js';
import { sendWeComText } from '../wecom/api.js';

/** 累计几次「不感兴趣」才认为与订阅冲突。 */
export const CONFLICT_THRESHOLD = 3;
/** 同一个词的提示冷却期：30 天。 */
export const CONFLICT_PROMPT_TTL_MS = 30 * 24 * 3600 * 1000;

export interface ConflictCandidate {
  term: string;
  count: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 找出与订阅词冲突的方向（纯函数）。
 *
 * 只统计 `dislike` 事件；每个事件的语言/话题合集去重后再看是否包含该词，
 * 因此「一条事件同时命中语言与话题」只算一次。结果按次数降序、同次数按
 * 词名升序，保证同一批事件永远给同一个答案。
 */
export function conflictTerms(
  events: FeedbackEvent[],
  terms: string[],
): ConflictCandidate[] {
  const uniqueTerms = [...new Set(terms.map(normalize).filter(Boolean))];
  const counts = new Map<string, number>(uniqueTerms.map((term) => [term, 0]));

  for (const event of events) {
    if (event.kind !== 'dislike') continue;
    const touched = new Set<string>([
      ...event.languages.map(normalize),
      ...event.topics.map(normalize),
    ]);
    for (const term of uniqueTerms) {
      if (touched.has(term)) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
  }

  return uniqueTerms
    .map((term) => ({ term, count: counts.get(term) ?? 0 }))
    .filter((candidate) => candidate.count >= CONFLICT_THRESHOLD)
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

/** 提示文案：点名冲突、给出精确命令、说明不回复也没关系。 */
export function conflictPrompt(term: string): string {
  return [
    `「${term}」是你订阅的关键词，但最近几次「不感兴趣」都落在这个方向。`,
    `要把「${term}」从订阅里去掉吗？回复「取消订阅 ${term}」即可；不回复则保持原样。`,
  ].join('\n');
}

function markerKey(wecomUserid: string, term: string): string {
  return `conflict:v1:${wecomUserid}:${normalize(term)}`;
}

/**
 * 该词 30 天内是否已提示过。
 * 读取失败按「已提示」处理：重复唠叨比漏一次提示更伤用户。
 */
async function alreadyPrompted(
  wecomUserid: string,
  term: string,
  now: Date,
): Promise<boolean> {
  try {
    const rows = await db()
      .select({ expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, markerKey(wecomUserid, term)))
      .limit(1);
    const row = rows[0];
    return row !== undefined && row.expiresAt.getTime() > now.getTime();
  } catch (err) {
    console.error('[conflict] marker read failed:', err instanceof Error ? err.message : err);
    return true;
  }
}

/** 写 30 天标记。失败只记日志：提示已经发出去了，下次最多再提示一次。 */
async function markPrompted(
  wecomUserid: string,
  term: string,
  now: Date,
): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: markerKey(wecomUserid, term),
        value: { term: normalize(term), at: now.toISOString() },
        expiresAt: new Date(now.getTime() + CONFLICT_PROMPT_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.error('[conflict] marker write failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * 在一条「不感兴趣」回执之后调用：若存在未提示过的冲突词，补发一条提示。
 *
 * 全链路 fail-open：这里任何失败都不能影响已经发出的回执，也不该让
 * 反馈 handler 报错。没有订阅关键词、读不到事件都静默返回。
 */
export async function maybePromptConflict(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const snapshot = await readSubscription(wecomUserid);
    const raw = snapshot?.preferences.keywords;
    const terms = Array.isArray(raw)
      ? raw.map((term) => String(term).trim()).filter(Boolean)
      : [];
    if (terms.length === 0) return;

    const events = await readFeedback(wecomUserid, now);
    for (const candidate of conflictTerms(events, terms)) {
      if (await alreadyPrompted(wecomUserid, candidate.term, now)) continue;
      try {
        await sendWeComText(wecomUserid, conflictPrompt(candidate.term));
      } catch (err) {
        // 提示发不出去就别记标记：下次还有机会，而不是永久静默。
        console.error('[conflict] prompt send failed:', err instanceof Error ? err.message : err);
        return;
      }
      await markPrompted(wecomUserid, candidate.term, now);
      return;
    }
  } catch (err) {
    console.error('[conflict] skipped:', err instanceof Error ? err.message : err);
  }
}
