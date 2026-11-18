import { describe, expect, it } from 'vitest';
import {
  passesOpportunityGate,
  scoreOpportunity,
  selectOpportunityItems,
  toOpportunityItem,
} from '../src/opportunities/score';
import type { RawOpportunityFact } from '../src/opportunities/types';

const NOW = Date.parse('2026-11-18T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function fact(overrides: Partial<RawOpportunityFact> = {}): RawOpportunityFact {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤：... 期望：... 实际：...',
    url: 'https://github.com/acme/agent/issues/12',
    language: 'typescript',
    topics: ['agent'],
    stars: 500,
    license: 'MIT',
    archived: false,
    pushedAt: daysAgo(10),
    labels: ['good first issue'],
    comments: 3,
    reactions: 2,
    createdAt: daysAgo(20),
    updatedAt: daysAgo(2),
    maintainerEngaged: false,
    assigned: false,
    linkedPr: false,
    ...overrides,
  };
}

describe('passesOpportunityGate', () => {
  it('正常可行动 issue 通过', () => {
    expect(passesOpportunityGate(fact(), NOW)).toEqual({ ok: true, reasons: [] });
  });

  it('archived 仓库拒绝', () => {
    const result = passesOpportunityGate(fact({ archived: true }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('archived');
  });

  it('仓库超过 365 天没推送拒绝', () => {
    const result = passesOpportunityGate(fact({ pushedAt: daysAgo(400) }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('stale-repo');
  });

  it('issue 超过 90 天没更新拒绝', () => {
    const result = passesOpportunityGate(fact({ updatedAt: daysAgo(100) }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('stale-issue');
  });

  it('缺少更新时间按未知拒绝', () => {
    const result = passesOpportunityGate(fact({ updatedAt: null }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('stale-issue');
  });

  it('填坑已 assign 或已有 linked PR 拒绝', () => {
    expect(passesOpportunityGate(fact({ assigned: true }), NOW).reasons).toContain('assigned');
    expect(passesOpportunityGate(fact({ linkedPr: true }), NOW).reasons).toContain('linked-pr');
  });

  it('研究机会不要求未 assign', () => {
    const research = fact({ kind: 'research', assigned: true, labels: ['RFC'] });
    expect(passesOpportunityGate(research, NOW).ok).toBe(true);
  });
});

describe('scoreOpportunity', () => {
  it('good first issue 比普通 issue 高分', () => {
    expect(scoreOpportunity(fact(), NOW)).toBeGreaterThan(
      scoreOpportunity(fact({ labels: [] }), NOW),
    );
  });

  it('维护者近期参与加分', () => {
    expect(scoreOpportunity(fact({ maintainerEngaged: true }), NOW)).toBe(
      scoreOpportunity(fact(), NOW) + 15,
    );
  });

  it('research 标签加分', () => {
    const research = fact({ kind: 'research', labels: ['RFC'] });
    const plain = fact({ kind: 'research', labels: [] });
    expect(scoreOpportunity(research, NOW)).toBeGreaterThan(
      scoreOpportunity(plain, NOW),
    );
  });

  it('有讨论的 issue 比零讨论高分', () => {
    expect(scoreOpportunity(fact({ comments: 5 }), NOW)).toBeGreaterThan(
      scoreOpportunity(fact({ comments: 0 }), NOW),
    );
  });
});

describe('toOpportunityItem', () => {
  it('生成确定性模板、证据和难度', () => {
    const item = toOpportunityItem(fact(), NOW);
    expect(item.score).toBeGreaterThan(0);
    expect(item.why).toContain('issue');
    expect(item.firstStep.length).toBeGreaterThan(0);
    expect(item.evidence.map((entry) => entry.label)).toContain('标签');
    expect(item.evidence.map((entry) => entry.label)).toContain('讨论');
    expect(item.effort).toBe('小');
    expect(item.confidence).toBe('中');
  });

  it('维护者参与 + 有讨论 → 高置信度', () => {
    const item = toOpportunityItem(fact({ maintainerEngaged: true }), NOW);
    expect(item.confidence).toBe('高');
  });

  it('零讨论且无维护者参与 → 低置信度', () => {
    const item = toOpportunityItem(fact({ comments: 0 }), NOW);
    expect(item.confidence).toBe('低');
  });
});

describe('selectOpportunityItems', () => {
  it('过滤硬门槛并按 contribute/research 配额选择', () => {
    const facts = [
      fact(),
      fact({ id: 'contribute:acme/stale#1', archived: true }),
      fact({
        id: 'research:acme/agent#9',
        kind: 'research',
        issueNumber: 9,
        labels: ['RFC'],
        assigned: true,
      }),
    ];

    const items = selectOpportunityItems(facts, NOW, {
      contribute: 1,
      research: 1,
    });
    expect(items.map((item) => item.id).sort()).toEqual([
      'contribute:acme/agent#12',
      'research:acme/agent#9',
    ]);
  });

  it('同一 repo#issue 同时命中两类时只保留填坑', () => {
    const facts = [
      fact(),
      fact({
        id: 'research:acme/agent#12',
        kind: 'research',
        labels: ['RFC'],
        assigned: true,
      }),
    ];
    const items = selectOpportunityItems(facts, NOW, {
      contribute: 1,
      research: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('contribute:acme/agent#12');
  });

  it('某类不足时用另一类补齐', () => {
    const facts = [
      fact(),
      fact({ id: 'contribute:acme/two#2', issueNumber: 2 }),
      fact({ id: 'contribute:acme/three#3', issueNumber: 3 }),
    ];
    const items = selectOpportunityItems(facts, NOW, {
      contribute: 1,
      research: 2,
    });
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.kind === 'contribute')).toHaveLength(3);
  });
});
