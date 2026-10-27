import { inArray, sql } from 'drizzle-orm';
import { maybePromptConflict } from '../agent/conflict.js';
import { loadRecentResults, type RecentResultItem } from '../agent/recent-results.js';
import { normalizeRepoName } from '../agent/repo-name.js';
import {
  recordFeedback,
  type DigestCandidate,
  type FeedbackKind,
} from '../agent/taste.js';
import { db } from '../db/client.js';
import { repos } from '../db/schema.js';
import { EMPTY_SEARCH_CACHE_REPLY, NO_SEARCH_CACHE_REPLY } from '../github/stars.js';
import { sendWeComText } from './api.js';
import {
  FEEDBACK_USAGE_REPLY,
  parseFeedbackCommand,
  type FeedbackTarget,
} from './feedback-target.js';
import type { InboundMessage } from './router.js';

/**
 * 「感兴趣 / 不感兴趣」——看完简报回一个词。
 *
 * 两种粒度：
 * - 裸词：作用于刚收到的那一批（老行为）。语言/话题由 taste.dominantSignals
 *   取前 2 / 前 3，所以一次反馈最多影响两门语言，不会因为某天随手一句把整份简报砍掉。
 * - 加序号或仓库名（「不感兴趣 3」「不感兴趣 owner/repo」）：只影响点名的项目。
 *   用户看到 10 条里只有一条是噪声时，不该被迫把整批的方向都往下压。
 *
 * 所有分支都不写 search_caches：「收藏 N」必须始终指向用户最后收到的真实列表。
 * 目标解析失败（越界 / 不在最近结果里 / 混用）整条不写——半截生效比不生效更难解释。
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

/** 精确反馈的回执：点名，让用户确认「点的就是你那条」。 */
function namedReply(kind: FeedbackKind, candidates: DigestCandidate[]): string {
  const names = candidates.map((candidate) => {
    const language = candidate.language?.trim();
    return language ? `${candidate.fullName}（${language}）` : candidate.fullName;
  });
  // 名单以 ASCII 仓库名结尾时补一个空格，否则「x/1以后少推」连读成一坨。
  const sep = candidates[candidates.length - 1]?.language?.trim() ? '' : ' ';
  return `✅ 记下了：${names.join('、')}${sep}${kind === 'like' ? '以后多推' : '以后少推'}。`;
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

/**
 * 按 fullName 批量补一次语言/话题；查不到就退化成「只有 fullName」。
 *
 * 比较用 lower() 两边归一：GitHub 仓库名大小写不敏感，用户手打的写法
 * 与库里的写法不一定一致（「不感兴趣 A/GO1」也要能命中 a/go1）。
 */
async function loadCandidates(names: string[]): Promise<DigestCandidate[]> {
  const fallback: DigestCandidate[] = names.map((fullName) => ({
    fullName,
    language: null,
    topics: [],
  }));
  if (names.length === 0) return fallback;
  try {
    const lowered = [...new Set(names.map(normalizeRepoName))];
    const rows = await db()
      .select({
        fullName: repos.fullName,
        language: repos.language,
        topics: repos.topics,
      })
      .from(repos)
      .where(inArray(sql`lower(${repos.fullName})`, lowered));
    const byName = new Map(rows.map((row) => [normalizeRepoName(row.fullName), row]));
    return names.map((fullName) => {
      const row = byName.get(normalizeRepoName(fullName));
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

type Resolution =
  | { kind: 'ok'; names: string[] }
  | { kind: 'fail'; reply: string };

/** 把解析出来的目标映射到最近一次结果的真实条目；任何一个认不出就整条失败。 */
function resolveTargets(
  target: FeedbackTarget,
  items: RecentResultItem[],
): Resolution {
  if (target.kind === 'batch') {
    return { kind: 'ok', names: items.map((item) => item.fullName) };
  }
  if (target.kind === 'numbers') {
    for (const n of target.numbers) {
      if (items[n - 1] === undefined) {
        return { kind: 'fail', reply: `最近一次结果只有 ${items.length} 条，没有第 ${n} 条` };
      }
    }
    return { kind: 'ok', names: target.numbers.map((n) => items[n - 1]!.fullName) };
  }
  if (target.kind === 'repos') {
    const known = new Map(items.map((item) => [normalizeRepoName(item.fullName), item]));
    const missing = target.repos.filter((name) => !known.has(normalizeRepoName(name)));
    if (missing.length > 0) {
      return { kind: 'fail', reply: `最近一次结果里没有 ${missing.join('、')}` };
    }
    // 用用户手打的写法回显：他才知道自己点中的是哪一条。
    return { kind: 'ok', names: target.repos };
  }
  // invalid 在调用前已拦掉。
  return { kind: 'fail', reply: FEEDBACK_USAGE_REPLY };
}

async function applyFeedback(msg: InboundMessage, kind: FeedbackKind): Promise<void> {
  const parsed = parseFeedbackCommand(msg.content);
  if (parsed === null) {
    return;
  }
  if (parsed.target.kind === 'invalid') {
    await sendWeComText(msg.fromUserName, FEEDBACK_USAGE_REPLY);
    return;
  }

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

  const resolved = resolveTargets(parsed.target, recent.items);
  if (resolved.kind === 'fail') {
    await sendWeComText(userid, resolved.reply);
    return;
  }

  const candidates = await loadCandidates(resolved.names);

  let affected: { languages: string[]; topics: string[] };
  try {
    affected = await recordFeedback(userid, kind, candidates);
  } catch (err) {
    console.error('[feedback] write failed:', err instanceof Error ? err.message : err);
    await sendWeComText(userid, FEEDBACK_FAILED_REPLY);
    return;
  }

  if (parsed.target.kind === 'batch') {
    const languages = displayLanguages(affected.languages, candidates);
    await sendWeComText(
      userid,
      kind === 'like' ? interestedReply(languages) : notInterestedReply(languages),
    );
  } else {
    await sendWeComText(userid, namedReply(kind, candidates));
  }
  // 回执之后的第二条消息：订阅词与该方向持续冲突时，先问一句要不要去掉。
  // 只提示、不自动改；内部全链路 fail-open，绝不影响已发出的回执。
  if (kind === 'dislike') {
    await maybePromptConflict(userid);
  }
}

export async function handleInterested(msg: InboundMessage): Promise<void> {
  await applyFeedback(msg, 'like');
}

export async function handleNotInterested(msg: InboundMessage): Promise<void> {
  await applyFeedback(msg, 'dislike');
}
