import type { OpportunityItem } from './types.js';

/** 一条机会的文本卡片（6 行），供命令与周一推送共用。 */
export function formatOpportunityCards(items: OpportunityItem[]): string[] {
  return items.map((item, index) => {
    const kind = item.kind === 'contribute' ? '填坑' : '研究';
    return [
      `${index + 1}. [${kind}] ${item.repo} #${item.issueNumber}`,
      item.title,
      `为什么：${item.why}`,
      `第一步：${item.firstStep}`,
      `难度：${item.effort} · 置信度：${item.confidence}`,
      item.url,
    ].join('\n');
  });
}

/** 按 1900 字节预算从尾部减卡片；至少保留一张。 */
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
  return [header, '', cards[0] ?? '', footer].join('\n\n');
}
