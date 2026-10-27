import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 多轮状态：只记一件「系统刚问过、等用户回一个字」的事。
 *
 * 为什么只支持单槽：真正的对话状态机一旦无限生长，就会在微信这种「一句话一条
 * 消息」的界面上产生幽灵上下文——用户隔天回一个「对」，系统还记得上周的问句。
 * 所以这里刻意做窄：一个槽、5 分钟、任何其它消息都清空、读到坏值当作没有。
 *
 * 复用 kv_cache（`pending:v1:<userid>`），不建表（迁移 journal 的坑见
 * docs/deploy.md）。
 */

/** 5 分钟：够用户读完一句提示再回，又短到不会穿越到下一个话题。 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

const PENDING_KEY_PREFIX = 'pending:v1:';

export interface PendingProfileSuggestion {
  kind: 'profile-suggestion';
  /** 用户确认后要写进 profile 的那句话。 */
  fact: string;
  /** 写入时间，仅用于排障。 */
  at: string;
}

export type Pending = PendingProfileSuggestion | PendingSubscribeKeyword;

/** 裸「订阅」后的单槽追问：下一条消息要补上的关键词。 */
export interface PendingSubscribeKeyword {
  kind: 'subscribe-keyword';
  at: string;
}

export function pendingKey(wecomUserid: string): string {
  return `${PENDING_KEY_PREFIX}${wecomUserid}`;
}

function isPending(value: unknown): value is Pending {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'subscribe-keyword') {
    return typeof candidate.at === 'string';
  }
  return (
    candidate.kind === 'profile-suggestion' &&
    typeof candidate.fact === 'string' &&
    candidate.fact !== '' &&
    typeof candidate.at === 'string'
  );
}

/** 读不到 / 过期 / 坏值一律 null：调用方按「没有待办」处理。 */
export async function readPending(
  wecomUserid: string,
  now: Date = new Date(),
): Promise<Pending | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, pendingKey(wecomUserid)))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return null;
    return isPending(row.value) ? row.value : null;
  } catch (err) {
    console.error('[pending] read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 写失败返回 false 而不抛：建议记不上，不能连带把每周复盘也弄失败。 */
export async function setPending(
  wecomUserid: string,
  pending: Pending,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: pendingKey(wecomUserid),
        value: pending,
        expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
    return true;
  } catch (err) {
    console.error('[pending] write failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** 清空同样不抛：清理失败最多让状态多活 5 分钟。 */
export async function clearPending(wecomUserid: string): Promise<void> {
  try {
    await db().delete(kvCache).where(eq(kvCache.key, pendingKey(wecomUserid)));
  } catch (err) {
    console.error('[pending] clear failed:', err instanceof Error ? err.message : err);
  }
}

export type Confirmation = 'confirm' | 'reject';

const CONFIRM_WORDS = new Set([
  '对', '是', '好', '好的', '可以', '行', '嗯', '要', '记下', '记下来', 'ok', 'yes',
]);
const REJECT_WORDS = new Set([
  '不对', '不', '不是', '不用', '不用了', '不要', '否', '算了', '别', '不记', 'no',
]);

function normalizeConfirmationText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s。．.!！?？~～,，、；;:：]+$/u, '');
}

/**
 * 只认「整条消息就是一个答复」。一句话里只要还有别的内容，就当新消息——
 * 宁可漏掉一次确认，也不要把「不对，帮我搜 rust」吞成拒绝。
 */
export function interpretConfirmation(text: string): Confirmation | null {
  const normalized = normalizeConfirmationText(text);
  if (CONFIRM_WORDS.has(normalized)) return 'confirm';
  if (REJECT_WORDS.has(normalized)) return 'reject';
  return null;
}

/** 关键词上限：超过这个长度更像一句话，而不是订阅词。 */
export const PENDING_KEYWORD_MAX_CHARS = 40;

/**
 * 追问「想订阅什么」之后，只把「一个词（或逗号分隔的几个词）」当作槽值。
 * 含空格的内容视为新问题（「python 热榜」可能是一次搜索），宁可清掉待办也
 * 不能让追问吞掉用户真正想做的事。
 */
export function interpretKeyword(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/[。．.!！?？~～,，、；;:：]+$/u, '');
  if (trimmed === '') return null;
  if (/\s/u.test(trimmed)) return null;
  const chars = Array.from(trimmed);
  if (chars.length > PENDING_KEYWORD_MAX_CHARS) return null;
  return trimmed;
}

/** 把一周的净正/净负方向合成一句人话；没有信号就是空串。 */
export function buildSuggestionFact(stats: { more: string[]; less: string[] }): string {
  const parts: string[] = [];
  if (stats.more.length > 0) parts.push(`我最近更喜欢 ${stats.more.join('、')}`);
  if (stats.less.length > 0) {
    parts.push(`${stats.more.length > 0 ? '少看' : '我最近少看'} ${stats.less.join('、')}`);
  }
  return parts.join('，');
}

/** 建议文案：说清「记什么」，并给出两个字以内的退出方式。 */
export function suggestionText(fact: string): string {
  return [
    '🧠 从你这周的收藏和反馈里，我猜：',
    `「${fact}」`,
    '要我记住吗？回「对」记下，回「不」跳过。',
  ].join('\n');
}
