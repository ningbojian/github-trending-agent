import type {
  OpportunityConfidence,
  OpportunityEffort,
  OpportunityEvidence,
  OpportunityItem,
  RawOpportunityFact,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / DAY_MS));
}

function hasLabel(fact: RawOpportunityFact, label: string): boolean {
  const target = label.toLowerCase();
  return fact.labels.some((item) => item.trim().toLowerCase() === target);
}

const RESEARCH_LABELS = [
  'rfc',
  'proposal',
  'design proposal',
  'needs design',
  'research',
  'design',
];

/**
 * 硬门槛：仓库还活着、issue 还新鲜、没人占坑。
 * 未知新鲜度按不安全处理（宁可少推，也不推陈旧机会）。
 */
export function passesOpportunityGate(
  fact: RawOpportunityFact,
  now: number,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (fact.archived) reasons.push('archived');

  const repoAge = daysSince(fact.pushedAt, now);
  if (repoAge === null || repoAge > 365) reasons.push('stale-repo');

  const issueAge = daysSince(fact.updatedAt, now);
  if (issueAge === null || issueAge > 90) reasons.push('stale-issue');

  if (fact.kind === 'contribute' && fact.assigned) reasons.push('assigned');
  if (fact.kind === 'contribute' && fact.linkedPr) reasons.push('linked-pr');

  return { ok: reasons.length === 0, reasons };
}

/** 确定性排序分：只做质量和可行动性，不做用户个性化。 */
export function scoreOpportunity(
  fact: RawOpportunityFact,
  now: number,
): number {
  void now;
  let score = 50;

  if (hasLabel(fact, 'good first issue')) score += 15;
  if (hasLabel(fact, 'help wanted')) score += 10;

  if (fact.comments >= 1 && fact.comments <= 10) score += 10;
  else if (fact.comments > 10 && fact.comments <= 30) score += 5;
  else if (fact.comments > 30) score -= 5;

  if (fact.reactions >= 20) score += 15;
  else if (fact.reactions >= 5) score += 10;

  if (fact.maintainerEngaged) score += 15;

  if (fact.stars >= 10_000) score += 10;
  else if (fact.stars >= 1_000) score += 5;

  if (
    fact.kind === 'research' &&
    RESEARCH_LABELS.some((label) => hasLabel(fact, label))
  ) {
    score += 10;
  }

  return score;
}

function templateWhy(fact: RawOpportunityFact): string {
  const labels = fact.labels.length > 0 ? fact.labels.join(' / ') : '无标签';
  if (fact.kind === 'contribute') {
    return `这是一个可以上手的 issue：${labels}，${fact.comments} 条讨论。`;
  }
  return `这是一个开放问题：${labels}，${fact.comments} 条讨论。`;
}

function templateFirstStep(fact: RawOpportunityFact): string {
  return fact.kind === 'contribute'
    ? '先按 issue 描述复现，再在评论里说明你要接手。'
    : '先读 issue 里的未决问题，补一个复现或 benchmark。';
}

function effortFor(fact: RawOpportunityFact): OpportunityEffort {
  return fact.kind === 'contribute' && hasLabel(fact, 'good first issue')
    ? '小'
    : '中';
}

function confidenceFor(fact: RawOpportunityFact): OpportunityConfidence {
  if (fact.maintainerEngaged && fact.comments >= 1) return '高';
  if (fact.comments >= 1) return '中';
  return '低';
}

function evidenceFor(
  fact: RawOpportunityFact,
  now: number,
): OpportunityEvidence[] {
  const age = daysSince(fact.updatedAt, now);
  return [
    {
      label: '标签',
      value: fact.labels.length > 0 ? fact.labels.join(' / ') : '无',
    },
    { label: '讨论', value: `${fact.comments} 条评论` },
    {
      label: '维护者',
      value: fact.maintainerEngaged ? '近期参与' : '未确认',
    },
    { label: '更新', value: age === null ? '未知' : `${age} 天前` },
  ];
}

/** 事实 → 池条目；LLM 失败时这就是最终文案。 */
export function toOpportunityItem(
  fact: RawOpportunityFact,
  now: number,
): OpportunityItem {
  return {
    ...fact,
    score: scoreOpportunity(fact, now),
    why: templateWhy(fact),
    firstStep: templateFirstStep(fact),
    effort: effortFor(fact),
    confidence: confidenceFor(fact),
    evidence: evidenceFor(fact, now),
  };
}
