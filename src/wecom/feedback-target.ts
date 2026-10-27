import { isRepoToken, normalizeRepoName } from '../agent/repo-name.js';
import { parseCnNumber } from './cn-number.js';

/**
 * 「不感兴趣 3」/「不感兴趣 owner/repo」——把一次反馈精确限定到某几条。
 *
 * 为什么需要：整批反馈太粗。用户看到 10 条里只有一条是噪声，
 * 回一句「不感兴趣」会把整批的语言都往下压——他下次就不反馈了。
 *
 * 解析规则（纯函数，可单测）：
 * - 裸词 → 整批（老行为，不能倒退）；
 * - 全是序号 → 按序号；
 * - 全是仓库名 → 按仓库名（GitHub 大小写不敏感，去重时归一）；
 * - 混用 / 有条目认不出 / 超过 MAX_FEEDBACK_TARGETS → invalid，整条不生效。
 *
 * 动词后必须紧跟空白或结束：「感兴趣owner/repo」不是指令，仍当搜索。
 */

export const FEEDBACK_VERBS = ['不感兴趣', '感兴趣'] as const;
export type FeedbackVerb = (typeof FEEDBACK_VERBS)[number];

/** 一次最多指几条：再多就该整批反馈了，逐条点名反而容易点错。 */
export const MAX_FEEDBACK_TARGETS = 10;

export const FEEDBACK_USAGE_REPLY =
  '用法：「不感兴趣 3」「不感兴趣 3,5」「不感兴趣 owner/repo」；不加参数则作用于刚收到的一批。';

export type FeedbackTarget =
  | { kind: 'batch' }
  | { kind: 'numbers'; numbers: number[] }
  | { kind: 'repos'; repos: string[] }
  | { kind: 'invalid'; reason: 'mixed' | 'too-many' | 'bad-token' };

export interface FeedbackCommand {
  verb: FeedbackVerb;
  target: FeedbackTarget;
}

/** 与 router 的尾标点纪律一致（「不感兴趣。」等同裸词）。 */
const TRAILING_PUNCT_RE = /[。！？!?；;，,．.…]+$/;

/** 分隔符：中英文逗号、顿号、空白（与 onboarding 的偏好切分同风格）。 */
const SEPARATOR_RE = /[,，、\s]+/;

function parseTarget(rest: string): FeedbackTarget {
  if (rest === '') {
    return { kind: 'batch' };
  }
  const tokens = rest.split(SEPARATOR_RE).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { kind: 'batch' };
  }
  if (tokens.length > MAX_FEEDBACK_TARGETS) {
    return { kind: 'invalid', reason: 'too-many' };
  }

  const numbers: number[] = [];
  const repos: string[] = [];
  const seenRepos = new Set<string>();

  for (const token of tokens) {
    const n = parseCnNumber(token);
    if (n !== null) {
      if (!numbers.includes(n)) numbers.push(n);
      continue;
    }
    if (isRepoToken(token)) {
      const key = normalizeRepoName(token);
      if (!seenRepos.has(key)) {
        seenRepos.add(key);
        repos.push(token);
      }
      continue;
    }
    return { kind: 'invalid', reason: 'bad-token' };
  }

  if (numbers.length > 0 && repos.length > 0) {
    return { kind: 'invalid', reason: 'mixed' };
  }
  return numbers.length > 0
    ? { kind: 'numbers', numbers }
    : { kind: 'repos', repos };
}

/**
 * 解析一条口味指令；不是指令（无关文本、动词后无空白）返回 null。
 * 是动词但参数有问题返回 `invalid`——调用方据此回用法提示、且**不写信号**。
 */
export function parseFeedbackCommand(content: string): FeedbackCommand | null {
  const text = content.trim().replace(TRAILING_PUNCT_RE, '');
  const verb = FEEDBACK_VERBS.find((candidate) => text.startsWith(candidate));
  if (verb === undefined) {
    return null;
  }
  const rest = text.slice(verb.length);
  if (rest !== '' && !/^\s/.test(rest)) {
    return null;
  }
  return { verb, target: parseTarget(rest.trim()) };
}
