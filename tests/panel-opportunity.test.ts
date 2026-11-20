import { describe, expect, it } from 'vitest';
import { renderOpportunityCards } from '../src/panel/opportunity-view';
import type { OpportunityItem } from '../src/opportunities/types';

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 <script>alert(1)</script> 检测失败',
    body: '...',
    url: 'https://github.com/acme/agent/issues/12',
    language: 'typescript',
    topics: ['agent'],
    stars: 500,
    license: 'MIT',
    archived: false,
    pushedAt: '2026-11-10T00:00:00.000Z',
    labels: ['good first issue'],
    comments: 3,
    reactions: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    maintainerEngaged: true,
    assigned: false,
    linkedPr: false,
    short: '<script>alert(1)</script>',
    score: 80,
    why: '值得修。',
    firstStep: '复现并认领。',
    effort: '小',
    confidence: '高',
    evidence: [{ label: '讨论', value: '3 条评论' }],
    ...overrides,
  };
}

describe('renderOpportunityCards', () => {
  it('渲染卡片、转义不可信文本、带三种操作', () => {
    const html = renderOpportunityCards([item()], 'tok');
    expect(html).toContain('acme/agent');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('name="action" value="opp-hide"');
    expect(html).toContain('name="action" value="opp-track"');
    expect(html).toContain('name="action" value="opp-favorite"');
    expect(html).toContain('view=opportunities');
    expect(html).toContain('t=tok');
  });

  it('空列表返回空串', () => {
    expect(renderOpportunityCards([], 'tok')).toBe('');
  });
});
