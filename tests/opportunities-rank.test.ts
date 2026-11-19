import { describe, expect, it } from 'vitest';
import {
  opportunitySignature,
  rankOpportunities,
  type OpportunitySignals,
} from '../src/opportunities/rank';
import type { OpportunityItem } from '../src/opportunities/types';

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤...',
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
    score: 80,
    why: 'why',
    firstStep: 'first',
    effort: '小',
    confidence: '中',
    evidence: [],
    ...overrides,
  };
}

function signals(
  overrides: Partial<OpportunitySignals> = {},
): OpportunitySignals {
  return {
    languages: [],
    topics: [],
    keywords: [],
    languageBoost: new Map(),
    topicBoost: new Map(),
    favoriteRepos: new Set(),
    trackedRepos: new Set(),
    hidden: new Set(),
    shown: new Set(),
    ...overrides,
  };
}

describe('rankOpportunities', () => {
  it('签名按 repo#issue，不受 kind 影响', () => {
    expect(opportunitySignature(item())).toBe('acme/agent#12');
    expect(opportunitySignature(item({ kind: 'research' }))).toBe(
      'acme/agent#12',
    );
  });

  it('shown 存 repo#issue 也能过滤不同 kind 的同 issue', () => {
    const research = item({
      id: 'research:acme/agent#12',
      kind: 'research',
      labels: ['RFC'],
    });
    const ranked = rankOpportunities(
      [research],
      signals({ shown: new Set(['acme/agent#12']) }),
      { limit: 1, contribute: 0, research: 1 },
    );
    expect(ranked).toEqual([]);
  });

  it('语言过滤 + hidden/shown 过滤', () => {
    const items = [
      item(),
      item({ id: 'contribute:acme/py#1', repo: 'acme/py', language: 'python' }),
      item({ id: 'contribute:acme/hidden#2', repo: 'acme/hidden' }),
    ];

    const ranked = rankOpportunities(
      items,
      signals({
        languages: ['typescript'],
        hidden: new Set(['contribute:acme/hidden#2']),
        shown: new Set(['contribute:acme/agent#12']),
      }),
      { limit: 3, contribute: 3, research: 0 },
    );

    expect(ranked.map((entry) => entry.id)).toEqual([]);
  });

  it('方向/关键词/收藏提升排序', () => {
    const agent = item({
      id: 'contribute:acme/agent#12',
      repo: 'acme/agent',
      topics: ['agent'],
      score: 80,
    });
    const other = item({
      id: 'contribute:acme/other#13',
      repo: 'acme/other',
      topics: ['database'],
      title: '数据库连接失败',
      score: 80,
    });
    const ranked = rankOpportunities([agent, other], signals({
      topics: ['agent'],
      keywords: ['windows'],
      favoriteRepos: new Set(['acme/agent']),
    }), { limit: 1, contribute: 1, research: 0 });

    expect(ranked[0]?.id).toBe('contribute:acme/agent#12');
  });

  it('同一 repo 最多一条，语言最多两条', () => {
    const items = [
      item({ id: 'contribute:acme/agent#1', repo: 'acme/agent', issueNumber: 1 }),
      item({ id: 'contribute:acme/agent#2', repo: 'acme/agent', issueNumber: 2 }),
      item({ id: 'contribute:acme/one#3', repo: 'acme/one', issueNumber: 3 }),
    ];
    const ranked = rankOpportunities(items, signals(), {
      limit: 3,
      contribute: 3,
      research: 0,
    });
    expect(ranked).toHaveLength(2);
    expect(new Set(ranked.map((entry) => entry.repo)).size).toBe(2);
  });

  it('按 2 contribute + 1 research 取，research 不足用 contribute 补', () => {
    const items = [
      item({ id: 'c1', repo: 'a/1', issueNumber: 1, language: 'typescript' }),
      item({ id: 'c2', repo: 'a/2', issueNumber: 2, language: 'python' }),
      item({ id: 'c3', repo: 'a/3', issueNumber: 3, language: 'rust' }),
    ];
    const ranked = rankOpportunities(items, signals(), {
      limit: 3,
      contribute: 2,
      research: 1,
    });
    expect(ranked).toHaveLength(3);
    expect(ranked.every((entry) => entry.kind === 'contribute')).toBe(true);
  });

  it('research 单独配额生效', () => {
    const items = [
      item({ id: 'c1', repo: 'a/1', issueNumber: 1 }),
      item({
        id: 'r1',
        kind: 'research',
        repo: 'a/r1',
        issueNumber: 9,
        labels: ['RFC'],
        comments: 8,
      }),
    ];
    const ranked = rankOpportunities(items, signals(), {
      limit: 3,
      contribute: 2,
      research: 1,
    });
    expect(ranked.map((entry) => entry.id).sort()).toEqual(['c1', 'r1']);
  });
});
