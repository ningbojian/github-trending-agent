import type { NewsArticle } from '../wecom/news.js';
import type { OpportunityItem } from './types.js';

function truncateChars(text: string, maxChars: number): string {
  const chars = [...text.trim()];
  if (chars.length <= maxChars) return text.trim();
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/** 一条机会的文本卡片（6 行），供命令与周一推送共用。 */
export function formatOpportunityCards(items: OpportunityItem[]): string[] {
  return items.map((item, index) => {
    const kind = item.kind === 'contribute' ? '填坑' : '研究';
    return [
      `${index + 1}. [${kind}] ${truncateChars(item.repo, 80)} #${item.issueNumber}`,
      truncateChars(item.title, 100),
      `为什么：${truncateChars(item.why, 100)}`,
      `第一步：${truncateChars(item.firstStep, 100)}`,
      `难度：${item.effort} · 置信度：${item.confidence}`,
      item.url,
    ].join('\n');
  });
}

/** 按 UTF-8 字节硬截断，保证不把多字节字符切成乱码。 */
function truncateUtf8(text: string, maxBytes: number): string {
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > maxBytes) break;
    out += char;
  }
  return out;
}

/** 按字节预算从尾部减卡片；单张卡也超限时做最终硬截断。 */
export function fitOpportunityText(
  header: string,
  items: OpportunityItem[],
  footer: string,
  maxBytes = 1900,
): string {
  const cards = formatOpportunityCards(items);
  for (let count = cards.length; count >= 1; count -= 1) {
    const text = [header, '', ...cards.slice(0, count), footer].join('\n\n');
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  }
  const fallback = [header, '', cards[0] ?? '', footer].join('\n\n');
  return truncateUtf8(fallback, maxBytes);
}

function clipTitle(text: string, maxBytes = 120): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > budget) break;
    out += char;
  }
  return `${out.trimEnd()}${ellipsis}`;
}

/** 企微 news 卡片：仓库名在最前，why/第一步放在 description；首篇带仓库 OG 图。 */
export function buildOpportunityArticles(
  items: OpportunityItem[],
): NewsArticle[] {
  return items.map((item, index) => {
    const kind = item.kind === 'contribute' ? '填坑' : '研究';
    return {
      title: clipTitle(
        `[${kind}] ${item.repo} #${item.issueNumber} · ${item.why}`,
      ),
      description: `${item.why} · 第一步：${item.firstStep}`,
      url: item.url,
      ...(index === 0
        ? { picurl: `https://opengraph.githubassets.com/1/${item.repo}` }
        : {}),
    };
  });
}
