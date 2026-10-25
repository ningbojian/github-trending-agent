import { z } from 'zod';
import { generateObjectSafe } from './llm.js';

/**
 * 每日简报开头的 Abstract：把当天榜单整合成一段 2–3 句的概览。
 *
 * - 快照构建（digest-snapshot）与快照不可用时的回退构建（digest）共用这一份
 *   提示词、截断口径与失败语义，避免两条路径写出两种风格。
 * - 一次小调用；任何失败返回 null —— 简报照常发送，绝不因为缺一段概览而丢列表。
 * - 上限按**码点**截断，不按字节：企微的 2048 字节限制由 assemble 统一兜底。
 */

/** Abstract 上限（按码点）。 */
export const ABSTRACT_MAX_CHARS = 120;

const abstractSchema = z.object({ abstract: z.string() });

/** 参与概览的最小条目形状（仓库名 + 可选中文简介都由 summaries 提供）。 */
export interface AbstractSourceItem {
  fullName: string;
}

/** 按码点截断（不会把代理对切成半个字符），并去掉首尾空白。 */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/**
 * 概览提示词：只要求概括共同主题/方向，**不逐个列举仓库**——
 * 列表紧跟在这一段后面，逐条复述会让第一屏变成两份榜单。
 */
export function buildAbstractPrompt(
  items: AbstractSourceItem[],
  summaries: Map<string, string>,
): string {
  const lines = items.map((item) => {
    const zh = summaries.get(item.fullName)?.trim();
    return `- ${item.fullName}${zh ? `：${zh}` : ''}`;
  });
  return [
    `下面是今天 GitHub 热榜的仓库列表。请写 2 到 3 句话、不超过 ${ABSTRACT_MAX_CHARS} 个汉字的今日概览：`,
    '1. 只概括共同主题或方向，不逐个列举仓库，不编造列表之外的事实；',
    '2. 语气客观中性，不用营销词、不用 emoji；',
    '3. 以 JSON 输出：{"abstract":"..."}。',
    '',
    '仓库列表：',
    ...lines,
  ].join('\n');
}

/**
 * 生成概览；空列表 / 模型失败 / 空白结果一律返回 null。
 * 空列表这一条尤其重要：没有可概括的内容时不该发起调用。
 */
export async function loadAbstractSafe(
  items: AbstractSourceItem[],
  summaries: Map<string, string>,
): Promise<string | null> {
  if (items.length === 0) {
    return null;
  }
  try {
    const out = await generateObjectSafe(
      abstractSchema,
      buildAbstractPrompt(items, summaries),
    );
    const text = out?.abstract?.trim();
    if (!text) return null;
    return truncateChars(text, ABSTRACT_MAX_CHARS);
  } catch {
    return null;
  }
}
