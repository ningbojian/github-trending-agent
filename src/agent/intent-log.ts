import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { shanghaiToday } from './time.js';
import { normalizeQueryText } from './query-cache.js';
import type { Intent } from './intent.js';

/**
 * 匿名意图日志：让规则层（intent.ts）靠真实语料自己长大。
 *
 * 不记录所有消息——绝大多数是正常搜索，只是噪音，还会把真正值钱的样本淹掉。
 * 只记三类「规则层没学到」的输入：
 *   1. 最终判成 about / off_topic   → 规则漏判的闲聊
 *   2. 搜出来 0 条                  → 多半是没听懂用户想搜什么
 *   3. 短句（≤10 字）               → 指令写错字、口语化的一句话
 * 排在前面的说法就是下一批该写进 ABOUT_PATTERNS / OFF_TOPIC_TOPICS 的规则。
 *
 * 匿名：只存归一化后的原话，**不存 wecom_userid**——需要看「大家怎么说话」，
 * 不需要看「谁在说」。key 按天分桶，同日同句只留一行，天然限流。
 *
 * 复用 kv_cache（不建表）：迁移 0004 会被 journal 时间戳静默跳过，见
 * docs/deploy.md 第 1 节。写失败一律吞掉——日志永远不能把搜索弄挂。
 */

/** 原话上限：够看出说法，又不至于把日志变成聊天记录转存。 */
export const INTENT_LOG_MAX_CHARS = 60;
/** 120 天：三个多月的语料足够看出高频说法，过期靠 TTL 自然清理。 */
export const INTENT_LOG_TTL_MS = 120 * 24 * 60 * 60 * 1000;
/** 短句阈值（按码点计，中文一字算一个）。 */
export const SHORT_TEXT_CHARS = 10;

export interface MissInput {
  /** classifyByRules 的原始结论（null = 规则拿不准）。 */
  ruleIntent: Intent | null;
  /** 最终生效的意图（LLM 判定，或规则命中）。 */
  finalIntent: Intent;
  /** 本次检索结果条数（非搜索分支传 0）。 */
  resultCount: number;
  text: string;
}

/**
 * 这条输入值不值得记（纯函数，零 I/O）。
 *
 * 规则已经判对的不记：规则本来就会处理它，记下来也只是重复同一句
 * 「off_topic」，对补规则没有任何新增信息。
 */
export function shouldLogMiss(input: MissInput): boolean {
  const { ruleIntent, finalIntent, resultCount, text } = input;
  if (ruleIntent === finalIntent) {
    return false;
  }
  if (finalIntent !== 'search') {
    return true;
  }
  if (resultCount === 0) {
    return true;
  }
  return Array.from(text.trim()).length <= SHORT_TEXT_CHARS;
}

/** `intent-miss:<北京日期>:<sha1(归一化文本)>`——同日同句只占一行。 */
export function intentMissKey(text: string, now: Date = new Date()): string {
  const day = shanghaiToday(now).replace(/-/g, '');
  const digest = createHash('sha1')
    .update(normalizeQueryText(text))
    .digest('hex');
  return `intent-miss:${day}:${digest}`;
}

function truncate(text: string): string {
  return Array.from(text).slice(0, INTENT_LOG_MAX_CHARS).join('');
}

/** 记一条匿名样本；任何失败只记日志，不影响本次回复。 */
export async function recordIntentMiss(
  text: string,
  finalIntent: Intent,
  now: Date = new Date(),
): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: intentMissKey(text, now),
        value: { text: truncate(text), final: finalIntent },
        expiresAt: new Date(now.getTime() + INTENT_LOG_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.error(
      '[intent-log] write failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
