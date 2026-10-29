import type { DailyObservations } from '../agent/observation.js';
import type { NewsArticle } from './news.js';

/**
 * 「今日观察」卡片：单篇 news，品牌封面 + 2–3 条判断。
 *
 * 为什么用卡片：纯文本列表在微信里就是「一堆仓库名」，观感和信息密度都差；
 * 单篇 news 卡片有大图、标题和可读的描述区，且不占每日简报的 8 个位置。
 * 描述上限 512 字节（企微硬限制），放不下就按整条丢弃，绝不截半句。
 */

export const OBSERVATION_DESCRIPTION_MAX_BYTES = 500;

export function buildObservationArticle(
  observations: DailyObservations,
  baseUrl?: string,
  url = 'https://github.com/trending',
): NewsArticle {
  const title = `👀 今日观察 · ${observations.date.slice(5)}`;
  const lines = observations.lines.map(
    (line, index) => `${index + 1}. ${line.claim}`,
  );

  let description = '';
  for (const line of lines) {
    const next = description === '' ? line : `${description}\n${line}`;
    if (Buffer.byteLength(next, 'utf8') > OBSERVATION_DESCRIPTION_MAX_BYTES) break;
    description = next;
  }

  return {
    title,
    ...(description !== '' ? { description } : {}),
    url,
    ...(baseUrl !== undefined
      ? {
          picurl: `${baseUrl.replace(/\/+$/, '')}/docs/assets/observation-cover.png`,
        }
      : {}),
  };
}
