import type { NewsArticle } from '../wecom/news.js';
import type { OpportunityItem } from './types.js';

function truncateChars(text: string, maxChars: number): string {
  const chars = [...text.trim()];
  if (chars.length <= maxChars) return text.trim();
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/** 机会卡片只用纯中文/常规标点：去掉 emoji、装饰符号和多余空白。 */
export function plainText(value: string): string {
  return value
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/[·•｜|]/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * issue 标题常常以 `[Bug]:`、`[RFC]`、`proposal:`、`Tracking issue for` 开头，
 * 直接截前 12 字会只剩 `[Bug]` / `D3D12` 这种没有信息量的碎片。
 * 这里只剥标签与套话前缀，保留真正的模块名（如 `D3D12:`）和问题描述。
 */
export function cleanIssueTitle(title: string): string {
  return title
    .replace(/^\s*(?:\[[^\]]{1,24}\]\s*[:：\-–—]?\s*)+/u, '')
    .replace(/^(?:tracking issue for|discussion on)\s+/i, '')
    .replace(
      /^(?:proposal|feature request|bug report|bug|rfc|help wanted|enhancement)\s*[:：]\s*/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 卡片第一行：仓库描述。优先池里生成好的中文简介，其次 GitHub 原始
 * description，最后退回仓库名——保证第一行永远有内容。
 */
export function opportunityRepoLine(item: OpportunityItem): string {
  const summary = plainText(item.repoSummary ?? '');
  if (summary !== '') return truncateChars(summary, 120);
  const description = plainText(item.repoDescription ?? '');
  if (description !== '') return truncateChars(description, 120);
  return plainText(item.repo);
}

/** 卡片第二行：这个 issue 要解决的问题（不带「第一步」）。 */
export function opportunityIssueLine(item: OpportunityItem): string {
  return opportunityShort(item);
}

/**
 * 卡片/标题用的短句：优先用池里的中文 short。
 * 旧池的模板短句是英文碎片（`[Bug]`、`D3D12`、`proposal`），没有信息量，
 * 直接改用清洗后的完整 issue 标题描述问题。
 */
export function opportunityShort(item: OpportunityItem): string {
  const short = plainText(item.short ?? '');
  const problem = truncateChars(plainText(cleanIssueTitle(item.title)), 120);
  const shortHasChinese = /\p{Script=Han}/u.test(short);
  if (short !== '' && shortHasChinese) return short;
  if (problem !== '') return problem;
  if (short !== '') return short;
  return item.kind === 'contribute' ? '可上手的 issue' : '开放问题';
}

/** 一条机会的文本卡片（5 行）：仓库描述 → issue 问题 → 仓库引用。 */
export function formatOpportunityCards(items: OpportunityItem[]): string[] {
  return items.map((item, index) => {
    return [
      `${index + 1}. ${opportunityRepoLine(item)}`,
      opportunityIssueLine(item),
      `${plainText(item.repo)}，issue ${item.issueNumber}`,
      `难度：${item.effort}，置信度：${item.confidence}`,
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

/** 企微 news 卡片：标题「仓库描述｜issue 问题」，description 里再放问题与引用。 */
export function buildOpportunityArticles(
  items: OpportunityItem[],
): NewsArticle[] {
  return items.map((item, index) => {
    const repoLine = opportunityRepoLine(item);
    const issueLine = opportunityIssueLine(item);
    return {
      title: clipTitle(`${repoLine}｜${issueLine}`),
      description: `${issueLine}。${plainText(item.repo)}，issue ${item.issueNumber}`,
      url: item.url,
      ...(index === 0
        ? { picurl: `https://opengraph.githubassets.com/1/${item.repo}` }
        : {}),
    };
  });
}
