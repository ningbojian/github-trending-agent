import { parseSearchQuery } from '../agent/parse-query';
import { searchTrending, type SearchResultItem } from '../agent/search';
import { sendWeComText } from './api';
import type { InboundMessage } from './router';

/**
 * 消息回复引擎：把检索结果格式化成企微文本并推送。
 * - formatSearchReply：纯函数，编号列表 + 固定提示语，超长自动截断
 * - handleSearch：parse → search → format → sendWeComText，全链兜底异常
 */

/** 企微文本消息上限 ~2048 字节；1800 字节为安全阈值，超出即截断列表。 */
const MAX_REPLY_BYTES = 1800;

/** 编号列表末尾的固定提示语。 */
export const FAVORITE_HINT = "回复'收藏 N'可收藏并同步 star";

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

/** 单条：`1. owner/repo ★1234 (+567)（新上榜） — 描述`；description 缺失时省略破折号后段。 */
function formatItem(item: SearchResultItem, index: number): string {
  let line = `${index}. ${item.fullName} ★${item.stars} (+${item.starsDelta})`;
  if (item.isNew) {
    line += '（新上榜）';
  }
  if (item.description != null && item.description !== '') {
    line += ` — ${item.description}`;
  }
  return line;
}

function buildReply(lines: string[], truncated: boolean): string {
  const tail = truncated ? `${TRUNCATION_NOTE}\n${FAVORITE_HINT}` : FAVORITE_HINT;
  return lines.length === 0 ? tail : `${lines.join('\n')}\n${tail}`;
}

/**
 * 把检索结果格式化为编号列表 + 固定提示语（全中文交互文案）。
 * 超过 1800 字节（企微 ~2048 字节上限的安全阈值）时从尾部逐条丢弃，
 * 并在提示语前标注截断。空列表返回空串（空结果引导由 handleSearch 负责）。
 */
export function formatSearchReply(items: SearchResultItem[]): string {
  if (items.length === 0) {
    return '';
  }
  const allLines = items.map((item, i) => formatItem(item, i + 1));
  const full = buildReply(allLines, false);
  if (byteLength(full) <= MAX_REPLY_BYTES) {
    return full;
  }
  // 从尾部逐条丢弃，直到 剩余列表 + 截断标注 + 提示语 放得下（topN ≤ 25，代价可忽略）。
  let lines = allLines;
  while (lines.length > 0) {
    lines = lines.slice(0, -1);
    const candidate = buildReply(lines, true);
    if (byteLength(candidate) <= MAX_REPLY_BYTES) {
      return candidate;
    }
  }
  // 理论不可达：截断标注 + 提示语本身远小于 1800 字节。
  return buildReply([], true);
}

/**
 * 搜索 handler：parse → search → format → sendWeComText。
 * 空结果回引导文案；任何异常（LLM/检索/发送）都被兜住，
 * 保证用户总能收到某种中文回复，绝不让异常裸奔到 router 的 catch。
 */
export async function handleSearch(msg: InboundMessage): Promise<void> {
  try {
    const query = await parseSearchQuery(msg.content);
    const items = await searchTrending(query, msg.fromUserName);
    if (items.length === 0) {
      await sendWeComText(msg.fromUserName, EMPTY_RESULT_REPLY);
      return;
    }
    await sendWeComText(msg.fromUserName, formatSearchReply(items));
  } catch {
    try {
      await sendWeComText(msg.fromUserName, ERROR_REPLY);
    } catch {
      // 连兜底发送也失败：吞掉，避免异常传播到 router 的 catch。
    }
  }
}
