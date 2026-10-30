import { classifyByRules, type Intent } from '../agent/intent.js';
import { recordIntentMiss, shouldLogMiss } from '../agent/intent-log.js';
import { takeKeyHint } from '../agent/key-hint.js';
import type { LlmChoice } from '../agent/llm.js';
import { parseSearchQuery } from '../agent/parse-query.js';
import { loadRepoSummaries } from '../agent/repo-summary.js';
import { searchTrending, type SearchResultItem } from '../agent/search.js';
import { loadUserLlm } from '../agent/user-llm.js';
import { note, traceError } from '../obs/trace.js';
import { tryAgentReply } from './agent-route.js';
import { sendWeComText } from './api.js';
import { buildSetKeyLink } from './llm-settings.js';
import { ABOUT_REPLY, OFF_TOPIC_REPLY } from './onboarding.js';
import { routeToTools } from './tool-route.js';
import { formatEntryLine, MAX_TEXT_BYTES } from './text.js';
import type { InboundMessage } from './router.js';

/**
 * 消息回复引擎：把检索结果格式化成纯文本并推送。
 * - formatSearchReply：纯函数，编号列表（仓库 + 星数 + 裸链接 + 中文简介）+ 固定页脚，超长自动截断
 * - handleSearch：parse → search（空结果去关键词重查一次）→ summaries → sendWeComText，
 *   全链兜底异常
 *
 * 为什么发 text 而不是 markdown：企微的 markdown 消息在微工作台（个人微信
 * 那一侧）不可见，用户只会收到「暂时不支持此消息类型，请在企微中查看」。
 */

/** 企微文本消息内容上限 2048 字节；1900 字节为安全阈值，超出即截断列表。 */
export { MAX_TEXT_BYTES };

/** 搜索结果页脚：用具体例子教「序号精确反馈」+ 帮助入口。 */
export const GUIDANCE_FOOTER =
  '💡 「收藏 3」收藏第 3 条；「不感兴趣 3」只针对它；发「帮助」看全部指令';

/** 截断标注：出现在列表与提示语之间。 */
const TRUNCATION_NOTE = '（结果过多，已截断）';

/** 检索为空时的引导文案。 */
export const EMPTY_RESULT_REPLY =
  '没找到符合条件的项目，试试换个说法，比如指定语言或时间范围（例：「本周 python 的 AI 项目」）。';

/** 兜底错误文案：解析/检索/发送任一环节失败时保证用户仍有回复。 */
export const ERROR_REPLY = '抱歉，处理你的查询时出了点问题，请稍后再试。';

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 「这类问题需要模型」的软提示前缀（测试据此断言，别在别处复用）。 */
export const KEY_HINT_PREFIX = '💡 这类问题要模型才能答。';

function keyHintLine(wecomUserid: string): string {
  try {
    return `${KEY_HINT_PREFIX}用自己的 AI Key：${buildSetKeyLink(wecomUserid)}（15 分钟有效，只能用一次）`;
  } catch {
    // 未配置加密密钥：不给链接，只教命令。
    return `${KEY_HINT_PREFIX}发「设置模型」用自己的 AI Key 就能答。`;
  }
}

/**
 * 没配 Key 却问了需要模型的问题时，在检索结果后追一句提示。
 * 不提示的情形：7 天冷却中、追加后会超过文本上限、存储异常。
 */
async function appendKeyHint(
  wecomUserid: string,
  reply: string,
): Promise<string> {
  const hint = keyHintLine(wecomUserid);
  if (byteLength(reply) + byteLength(hint) + 2 > MAX_TEXT_BYTES) return reply;
  if (!(await takeKeyHint(wecomUserid))) return reply;
  return `${reply}\n\n${hint}`;
}

function buildReply(lines: string[], truncated: boolean): string {
  const tail = truncated
    ? `${TRUNCATION_NOTE}\n${GUIDANCE_FOOTER}`
    : GUIDANCE_FOOTER;
  return lines.length === 0 ? tail : `${lines.join('\n')}\n${tail}`;
}

/**
 * 把检索结果格式化为编号列表 + 固定页脚（全中文交互文案）。
 * 每条一行：`1. owner/repo ★1234 (+567)（新上榜） — 中文简介 https://github.com/owner/repo`；
 * 简介从 summaries 按 fullName 注入（Task 1 的 loadRepoSummaries 产物），
 * 缺失即省略破折号后段（不回退英文 description）。
 * 超过 1900 字节（企微文本消息 2048 字节上限的安全阈值）时从尾部逐条丢弃，
 * 并在页脚前标注截断。空列表返回空串（空结果引导由 handleSearch 负责）。
 */
export function formatSearchReply(
  items: SearchResultItem[],
  summaries: Map<string, string>,
): string {
  if (items.length === 0) {
    return '';
  }
  const allLines = items.map((item, i) =>
    formatEntryLine(i + 1, item, summaries.get(item.fullName)),
  );
  const full = buildReply(allLines, false);
  if (byteLength(full) <= MAX_TEXT_BYTES) {
    return full;
  }
  // 从尾部逐条丢弃，直到 剩余列表 + 截断标注 + 页脚 放得下（topN ≤ 25，代价可忽略）。
  let lines = allLines;
  while (lines.length > 0) {
    lines = lines.slice(0, -1);
    const candidate = buildReply(lines, true);
    if (byteLength(candidate) <= MAX_TEXT_BYTES) {
      return candidate;
    }
  }
  // 理论不可达：截断标注 + 页脚本身远小于 1900 字节。
  return buildReply([], true);
}

/**
 * 加载仓库中文简介；失败时降级为空 Map（该批条目省略简介），
 * 绝不因摘要失败丢掉已到手的搜索结果。
 */
async function loadSummariesSafe(
  items: SearchResultItem[],
  choice: LlmChoice,
): Promise<Map<string, string>> {
  try {
    return await loadRepoSummaries(items, choice);
  } catch (err) {
    console.error('loadRepoSummaries failed (degrade to no-summary):', err);
    traceError(err);
    return new Map();
  }
}

/**
 * 规则层没学到的样本才记（匿名；同日同句只留一行）。不 await：
 * 日志是副产品，绝不许拖慢给用户的回复。
 */
function logIntentMiss(
  ruleIntent: Intent | null,
  finalIntent: Intent,
  resultCount: number,
  text: string,
): void {
  if (shouldLogMiss({ ruleIntent, finalIntent, resultCount, text })) {
    void recordIntentMiss(text, finalIntent);
  }
}

/**
 * 搜索 handler：意图判断 → parse → search → format → sendWeComText。
 *
 * 意图边界（只拦明显无关）：先跑零成本规则（intent.ts），命中直接回文案；
 * 规则拿不准才交给 LLM 的结构化解析，再看它的 intent 字段。
 * about / off_topic 分支**绝不调用 searchTrending**——既不消耗检索配额，
 * 也不写 search_caches，保证「收藏 N」始终指向用户最后收到的真实列表。
 * 拿不准一律按搜索处理：漏判退化成老行为，不会误伤「今天有什么」这类正常提问。
 *
 * Token 归属：互动一律用**用户自己的 Key**（`设置模型` 配的）；没配就
 * `{ kind: 'none' }` —— 规则解析 + 只读共享缓存，运营方额度一分不花。
 * 每日推送仍走运营方 Key（app 内其他路径，不经过这里）。
 *
 * 匿名意图日志：规则漏判的 about / off_topic、0 条结果的搜索、≤10 字的短句
 * 会记一条匿名样本（src/agent/intent-log.ts），用来反推下一批该补的规则；
 * 正常搜索不记，样本里也不含任何身份字段。
 *
 * 首次检索为空且 query 带关键词时，去掉 keywords 再查一次（关键词常是
 * 用户主题词而非榜单词，ILIKE 易 0 命中，直接放弃等于「没找到」误伤）。
 * 空结果回引导文案；有结果加载中文简介后推送编号列表。
 * 任何异常（LLM/检索/发送）都被兜住，保证用户总能收到某种中文回复；
 * 异常不外抛，router 的 dispatchSafely 只作第二道安全网。
 */
export async function handleSearch(msg: InboundMessage): Promise<void> {
  try {
    const ruled = classifyByRules(msg.content);
    note('rule-intent', ruled ?? 'null');
    if (ruled === 'about') {
      note('reply', 'about');
      await sendWeComText(msg.fromUserName, ABOUT_REPLY);
      return;
    }
    if (ruled === 'off_topic') {
      note('reply', 'off_topic');
      await sendWeComText(msg.fromUserName, OFF_TOPIC_REPLY);
      return;
    }

    const userLlm = await loadUserLlm(msg.fromUserName);
    const choice: LlmChoice = userLlm
      ? { kind: 'user', config: userLlm }
      : { kind: 'none' };
    note('llm-choice', userLlm ? `user:${userLlm.model}` : 'none');

    // 规则前置：只有「点名仓库 / 深挖 / 靠不靠谱 / 改订阅」这类消息才进工具链路。
    // 普通搜索必须留在这条零模型、读共享缓存的路径上——进了工具就要烧 token，
    // 而「今天有什么」的回答质量并不会因为模型多跑一轮而变好。
    const toolRoute = routeToTools(msg.content);
    // 用户要的是模型能力（深挖 / 值不值得用），但没配 Key → 后面补一句提示。
    const wantsModel = toolRoute.kind === 'tools';
    if (toolRoute.kind === 'tools') {
      const handled = await tryAgentReply(msg, {
        choice,
        formatItems: formatSearchReply,
      });
      if (handled) {
        note('reply', `tool:${toolRoute.tool}`);
        return;
      }
      note('agent-route', '放弃 → 回退检索');
    }

    const query = await parseSearchQuery(msg.content, choice);
    note(
      'query',
      `intent=${query.intent} langs=[${query.languages.join(',')}] ` +
        `kw=[${query.keywords.join(',')}] period=${query.period} topN=${query.topN}`,
    );
    if (query.intent === 'about') {
      note('reply', 'about');
      logIntentMiss(ruled, 'about', 0, msg.content);
      await sendWeComText(msg.fromUserName, ABOUT_REPLY);
      return;
    }
    if (query.intent === 'off_topic') {
      note('reply', 'off_topic');
      logIntentMiss(ruled, 'off_topic', 0, msg.content);
      await sendWeComText(msg.fromUserName, OFF_TOPIC_REPLY);
      return;
    }

    let items = await searchTrending(query, msg.fromUserName);
    if (items.length === 0 && query.keywords.length > 0) {
      items = await searchTrending(
        { ...query, keywords: [] },
        msg.fromUserName,
      );
      note('search-retry', '去掉关键词再查一次');
    }
    note('search', `${items.length} 条`);
    if (items.length === 0) {
      note('reply', 'empty');
      logIntentMiss(ruled, 'search', 0, msg.content);
      await sendWeComText(msg.fromUserName, EMPTY_RESULT_REPLY);
      return;
    }
    logIntentMiss(ruled, 'search', items.length, msg.content);
    const summaries = await loadSummariesSafe(items, choice);
    note('summaries', `${summaries.size}/${items.length} 有中文简介`);
    let reply = formatSearchReply(items, summaries);
    if (wantsModel && choice.kind === 'none') {
      const withHint = await appendKeyHint(msg.fromUserName, reply);
      if (withHint !== reply) note('key-hint', 'shown');
      reply = withHint;
    }
    await sendWeComText(msg.fromUserName, reply);
    note('send', `ok ${Buffer.byteLength(reply, 'utf8')} 字节`);
  } catch (err) {
    console.error('handleSearch failed:', err);
    traceError(err);
    try {
      await sendWeComText(msg.fromUserName, ERROR_REPLY);
    } catch (fallbackErr) {
      // 连兜底发送也失败：仅记日志，吞掉不重试（防递归）。
      console.error('search error-reply send failed:', fallbackErr);
    }
  }
}
