import { escapeHtml } from '../http/html.js';
import type { OpportunityItem } from '../opportunities/types.js';

function href(token: string, view: string): string {
  const qs = new URLSearchParams({ view });
  if (token !== '') qs.set('t', token);
  return `?${qs.toString()}`;
}

function kindLabel(item: OpportunityItem): string {
  return item.kind === 'contribute' ? '填坑' : '研究';
}

function card(item: OpportunityItem, token: string): string {
  const action = href(token, 'opportunities');
  const chips = [
    `<span class="p-chip">${kindLabel(item)}</span>`,
    `<span class="p-chip">难度 ${escapeHtml(item.effort)}</span>`,
    `<span class="p-chip">置信度 ${escapeHtml(item.confidence)}</span>`,
    ...item.evidence.map(
      (entry) =>
        `<span class="p-chip">${escapeHtml(entry.label)}：${escapeHtml(entry.value)}</span>`,
    ),
  ].join('');
  return `<section class="p-card">
    <div class="p-chips">${chips}</div>
    <h2 class="p-card-title"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.repo)} #${item.issueNumber}</a></h2>
    <div class="p-hint">${escapeHtml(item.title)}</div>
    <p>${escapeHtml(item.why)}</p>
    <p><strong>第一步：</strong>${escapeHtml(item.firstStep)}</p>
    <div class="p-actions">
      <form method="post" action="${action}">
        <input type="hidden" name="action" value="opp-hide">
        <input type="hidden" name="id" value="${escapeHtml(item.id)}">
        <button class="p-btn ghost" type="submit">不感兴趣</button>
      </form>
      <form method="post" action="${action}">
        <input type="hidden" name="action" value="opp-track">
        <input type="hidden" name="repo" value="${escapeHtml(item.repo)}">
        <button class="p-btn ghost" type="submit">追踪仓库</button>
      </form>
      <form method="post" action="${action}">
        <input type="hidden" name="action" value="opp-favorite">
        <input type="hidden" name="fullName" value="${escapeHtml(item.repo)}">
        <button class="p-btn ghost" type="submit">收藏</button>
      </form>
    </div>
  </section>`;
}

export function renderOpportunityCards(
  items: OpportunityItem[],
  token: string,
): string {
  return items.map((item) => card(item, token)).join('');
}
