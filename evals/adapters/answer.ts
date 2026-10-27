import { z } from 'zod';
import type { SearchResultItem } from '../../src/agent/search.js';
import { formatSearchReply } from '../../src/wecom/reply.js';
import { readFixture } from '../load.js';
import type { AnswerExpectation } from '../schema.js';

/**
 * 答案观察器：用 fixture 结果集跑生产排版函数，检查「回复里的每个仓库
 * 都来自结果集」（groundedness）。
 *
 * 不调 searchTrending、不调模型：这是排版与截断的回归测试，不是质量评估。
 * 模型评分（答案好不好）另走 `--llm`，不进 CI。
 */
const FixtureSchema = z.array(
  z.object({
    fullName: z.string().min(1),
    description: z.string().nullable(),
    language: z.string().nullable(),
    stars: z.number(),
    starsDelta: z.number(),
    isNew: z.boolean(),
    date: z.string(),
    htmlUrl: z.string(),
    rank: z.number(),
  }),
);

export interface AnswerObservation {
  text: string;
  /** 回复里出现的仓库（从链接提取）。 */
  mentioned: string[];
  /** 结果集里没有、却被写进回复的仓库（必须为空）。 */
  ungrounded: string[];
  /** mustMention 里没出现的仓库。 */
  missing: string[];
}

/** 从「https://github.com/owner/repo」提取 owner/repo（去重、保序）。 */
export function extractRepoRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
  for (const match of text.matchAll(pattern)) {
    const ref = match[1];
    if (ref !== undefined && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  return refs;
}

export function observeAnswer(expected: AnswerExpectation): AnswerObservation {
  const items = FixtureSchema.parse(readFixture(expected.fixture)) as SearchResultItem[];
  const text = formatSearchReply(items, new Map());
  const known = new Set(items.map((item) => item.fullName.toLowerCase()));
  const mentioned = extractRepoRefs(text);
  const ungrounded = mentioned.filter((ref) => !known.has(ref.toLowerCase()));
  const missing = (expected.mustMention ?? []).filter(
    (ref) => !mentioned.some((seen) => seen.toLowerCase() === ref.toLowerCase()),
  );
  return { text, mentioned, ungrounded, missing };
}
