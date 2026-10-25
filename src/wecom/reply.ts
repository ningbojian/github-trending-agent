import { parseSearchQuery } from '../agent/parse-query.js';
import { loadRepoSummaries } from '../agent/repo-summary.js';
import { searchTrending, type SearchResultItem } from '../agent/search.js';
import { sendWeComText } from './api.js';
import { formatEntryLine } from './text.js';
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
export const MAX_TEXT_BYTES = 1900;

/** 搜索结果页脚：拿到结果后的下一步指引（收藏任意一条 / 查看全部指令）。 */
export const GUIDANCE_FOOTER =
  '💡 直接回复「收藏 N」收藏任意一条；发「帮助」查看全部指令';

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
): Promise<Map<string, string>> {
  try {
    return await loadRepoSummaries(items);
  } catch (err) {
    console.error('loadRepoSummaries failed (degrade to no-summary):', err);
    return new Map();
  }
}

/**
 * 搜索 handler：parse → search → format → sendWeComText。
 * 首次检索为空且 query 带关键词时，去掉 keywords 再查一次（关键词常是
 * 用户主题词而非榜单词，ILIKE 易 0 命中，直接放弃等于「没找到」误伤）。
 * 空结果回引导文案；有结果加载中文简介后推送编号列表。
 * 任何异常（LLM/检索/发送）都被兜住，保证用户总能收到某种中文回复；
 * 异常不外抛，router 的 dispatchSafely 只作第二道安全网。
 */
export async function handleSearch(msg: InboundMessage): Promise<void> {
  try {
    const query = await parseSearchQuery(msg.content);
    let items = await searchTrending(query, msg.fromUserName);
    if (items.length === 0 && query.keywords.length > 0) {
      items = await searchTrending(
        { ...query, keywords: [] },
        msg.fromUserName,
      );
    }
    if (items.length === 0) {
      await sendWeComText(msg.fromUserName, EMPTY_RESULT_REPLY);
      return;
    }
    const summaries = await loadSummariesSafe(items);
    await sendWeComText(msg.fromUserName, formatSearchReply(items, summaries));
  } catch (err) {
    console.error('handleSearch failed:', err);
    try {
      await sendWeComText(msg.fromUserName, ERROR_REPLY);
    } catch (fallbackErr) {
      // 连兜底发送也失败：仅记日志，吞掉不重试（防递归）。
      console.error('search error-reply send failed:', fallbackErr);
    }
  }
}
