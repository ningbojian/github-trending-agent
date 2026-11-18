import type { OpportunityItem } from './types.js';

/** 用户侧排序信号；全部来自内存里已加载的画像/偏好，不额外查库。 */
export interface OpportunitySignals {
  languages: string[];
  topics: string[];
  keywords: string[];
  languageBoost: Map<string, number>;
  topicBoost: Map<string, number>;
  favoriteRepos: Set<string>;
  trackedRepos: Set<string>;
  hidden: Set<string>;
  shown: Set<string>;
}

export interface RankOptions {
  limit?: number;
  contribute?: number;
  research?: number;
}

export function opportunitySignature(item: OpportunityItem): string {
  return item.id;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function hasLabel(item: OpportunityItem, label: string): boolean {
  const target = label.toLowerCase();
  return item.labels.some((entry) => entry.trim().toLowerCase() === target);
}

function kindTerm(item: OpportunityItem): number {
  if (item.kind === 'contribute') {
    if (hasLabel(item, 'good first issue')) return 1.5;
    if (hasLabel(item, 'help wanted')) return 1.2;
    return 1;
  }
  if (item.comments >= 5) return 1.5;
  if (item.maintainerEngaged) return 1.2;
  return 1;
}

function fitScore(item: OpportunityItem, signals: OpportunitySignals): number {
  const language = normalize(item.language);
  let boost = 2.5 * (signals.languageBoost.get(language) ?? 0);

  for (const topic of item.topics) {
    boost += 1.5 * (signals.topicBoost.get(normalize(topic)) ?? 0);
  }

  const directions = new Set(signals.topics.map(normalize));
  if (item.topics.some((topic) => directions.has(normalize(topic)))) {
    boost += 1;
  }

  const title = normalize(item.title);
  const body = normalize(item.body);
  if (
    signals.keywords.some((keyword) => {
      const needle = normalize(keyword);
      return needle.length > 0 && (title.includes(needle) || body.includes(needle));
    })
  ) {
    boost += 0.8;
  }

  if (
    signals.favoriteRepos.has(item.repo) ||
    signals.trackedRepos.has(item.repo)
  ) {
    boost += 0.5;
  }

  return item.score + boost + kindTerm(item);
}

/**
 * 共享池 → 用户可见的 2+1：
 * 硬过滤（语言/hidden/shown）→ 内存排序 → 同 repo 最多 1 条、同语言最多 2 条
 * → 按 kind 配额取 → 某类不足时用另一类补。没有合格条目就返回空。
 */
export function rankOpportunities(
  items: OpportunityItem[],
  signals: OpportunitySignals,
  options: RankOptions = {},
): OpportunityItem[] {
  const limit = options.limit ?? 3;
  const contributeQuota = Math.min(options.contribute ?? 2, limit);
  const researchQuota = Math.min(
    options.research ?? 1,
    Math.max(0, limit - contributeQuota),
  );
  const languages = new Set(signals.languages.map(normalize));

  const ranked = items
    .filter((item) => {
      if (signals.hidden.has(item.id) || signals.shown.has(item.id)) {
        return false;
      }
      const language = normalize(item.language);
      if (languages.size > 0 && !languages.has(language)) return false;
      return true;
    })
    .map((item) => ({ item, score: fitScore(item, signals) }))
    .sort(
      (a, b) =>
        b.score - a.score || a.item.id.localeCompare(b.item.id),
    );

  const picked: OpportunityItem[] = [];
  const seenRepos = new Set<string>();
  const languageCount = new Map<string, number>();

  const canTake = (item: OpportunityItem): boolean => {
    if (seenRepos.has(item.repo)) return false;
    return (languageCount.get(normalize(item.language)) ?? 0) < 2;
  };

  const take = (item: OpportunityItem): void => {
    picked.push(item);
    seenRepos.add(item.repo);
    const language = normalize(item.language);
    languageCount.set(language, (languageCount.get(language) ?? 0) + 1);
  };

  for (const { item } of ranked) {
    if (picked.length >= limit) break;
    if (item.kind !== 'contribute') continue;
    if (picked.filter((entry) => entry.kind === 'contribute').length >= contributeQuota) {
      continue;
    }
    if (!canTake(item)) continue;
    take(item);
  }

  for (const { item } of ranked) {
    if (picked.length >= limit) break;
    if (item.kind !== 'research') continue;
    if (picked.filter((entry) => entry.kind === 'research').length >= researchQuota) {
      continue;
    }
    if (!canTake(item)) continue;
    take(item);
  }

  for (const { item } of ranked) {
    if (picked.length >= limit) break;
    if (picked.includes(item)) continue;
    if (!canTake(item)) continue;
    take(item);
  }

  return picked;
}
