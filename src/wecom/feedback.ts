import { inArray } from 'drizzle-orm';
import { loadRecentResults } from '../agent/recent-results.js';
import {
  recordFeedback,
  type DigestCandidate,
  type FeedbackKind,
} from '../agent/taste.js';
import { db } from '../db/client.js';
import { repos } from '../db/schema.js';
import { EMPTY_SEARCH_CACHE_REPLY, NO_SEARCH_CACHE_REPLY } from '../github/stars.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「感兴趣 / 不感兴趣」——看完简报回一个词，作用于刚收到的那一批。
 *
 * 不做 `赞 N / 踩 N`：那要求用户翻回列表数序号，真实用户不会做。
 * 整批的语言/话题由 taste.dominantSignals 取前 2 / 前 3，所以一次反馈
 * 最多影响两门语言，不会因为某天随手一句把整份简报砍掉。
 *
 * 三个分支都不写 search_caches：「收藏 N」必须始终指向用户最后收到的真实列表。
 */

export const FEEDBACK_FAILED_REPLY = '⚠️ 没记住（存储出错），稍后再试一次。';
export const INTERESTED_GENERIC_REPLY = '✅ 记下了，会按这份简报的偏好多推同类项目。';
export const NOT_INTERESTED_GENERIC_REPLY =
  '✅ 记下了，以后少推这类项目（连提两次才会真正屏蔽）。';

function interestedReply(languages: string[]): string {
  return languages.length === 0
    ? INTERESTED_GENERIC_REPLY
    : `✅ 记下了：以后多推 ${languages.join('、')} 方向的项目。`;
}

function notInterestedReply(languages: string[]): string {
  return languages.length === 0
    ? NOT_INTERESTED_GENERIC_REPLY
    : `✅ 记下了：以后少推 ${languages.join('、')} 方向（连提两次才会真正屏蔽）。`;
}

/** 回执用仓库里的原始写法（Go / Rust），而不是内部归一化的小写。 */
function displayLanguages(names: string[], candidates: DigestCandidate[]): string[] {
  const byLower = new Map<string, string>();
  for (const candidate of candidates) {
    const original = candidate.language?.trim();
    if (!original) continue;
    const lower = original.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, original);
  }
  return names.map((name) => byLower.get(name) ?? name);
}

/** 按 fullName 批量补一次语言/话题；查不到就退化成「只有 fullName」。 */
async function loadCandidates(names: string[]): Promise<DigestCandidate[]> {
  const fallback: DigestCandidate[] = names.map((fullName) => ({
    fullName,
    language: null,
    topics: [],
  }));
  try {
    const rows = await db()
      .select({
        fullName: repos.fullName,
        language: repos.language,
        topics: repos.topics,
      })
      .from(repos)
      .where(inArray(repos.fullName, names));
    const byName = new Map(rows.map((row) => [row.fullName, row]));
    return names.map((fullName) => {
      const row = byName.get(fullName);
      return {
        fullName,
        language: row?.language ?? null,
        topics: Array.isArray(row?.topics) ? row.topics : [],
      };
    });
  } catch (err) {
    console.error('[feedback] repos lookup failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

async function applyFeedback(msg: InboundMessage, kind: FeedbackKind): Promise<void> {
  const userid = msg.fromUserName;
  const recent = await loadRecentResults(userid);
  if (!recent.found) {
    await sendWeComText(userid, NO_SEARCH_CACHE_REPLY);
    return;
  }
  if (recent.items.length === 0) {
    await sendWeComText(userid, EMPTY_SEARCH_CACHE_REPLY);
    return;
  }

  const candidates = await loadCandidates(recent.items.map((item) => item.fullName));

  let affected: { languages: string[]; topics: string[] };
  try {
    affected = await recordFeedback(userid, kind, candidates);
  } catch (err) {
    console.error('[feedback] write failed:', err instanceof Error ? err.message : err);
    await sendWeComText(userid, FEEDBACK_FAILED_REPLY);
    return;
  }

  const languages = displayLanguages(affected.languages, candidates);
  await sendWeComText(
    userid,
    kind === 'like' ? interestedReply(languages) : notInterestedReply(languages),
  );
}

export async function handleInterested(msg: InboundMessage): Promise<void> {
  await applyFeedback(msg, 'like');
}

export async function handleNotInterested(msg: InboundMessage): Promise<void> {
  await applyFeedback(msg, 'dislike');
}
