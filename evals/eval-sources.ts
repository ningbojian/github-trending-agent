import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { sourceItems, trendingEntries } from '../src/db/schema.js';

/**
 * HN / Lobsters 接入复评（ADR 0011 §后续评估）。
 *
 * 回答一个问题：攒了 14 天数据后，文章源够不够格进推送？
 *
 * 三个阈值（全部来自 ADR 0011，不要凭感觉改）：
 *   1. 每天指向 GitHub 仓库的条数 >= 5
 *   2. 与 Trending top 的重合 >= 10%
 *   3. HN / Lobsters 互相重复率可接受（这里定义为 < 20%）
 *
 * 设计纪律：
 * - 全程只读，没有一条 INSERT/UPDATE/DELETE。复评不能改变被复评的对象。
 * - 不进 CI：要读生产库，而 CI 的纪律是「无 secrets、无网络」。
 * - 只算事实、给建议，不自动改配置和推送——接不接是人做的决定。
 * - github.com 的链接要做形态过滤：gist / blob / 组织主页不算「仓库入口」，
 *   否则 ADR 里「2/24」那种噪音会被虚高。
 */

export interface SourceDayRow {
  source: string;
  day: string;
  url: string;
  title: string;
}

export interface TrendingRow {
  fullName: string;
  day: string;
}

export interface SourceVerdict {
  source: string;
  days: number;
  total: number;
  githubPerDay: number;
  overlapRate: number;
  crossDuplicateRate: number;
  passed: boolean;
  reasons: string[];
}

/** 从 url 里抽出 owner/repo；只认 github.com/owner/repo 形态，排除 gist/blob/组织主页。 */
export function repoFromUrl(url: string): string | null {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(url);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  if (owner === 'gist' || owner === 'topics' || owner === 'orgs') return null;
  if (repo === 'blob' || repo === 'tree' || repo === 'issues' || repo === 'pull') return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** 标题归一化，用于跨源重复判断（去标点、小写、压空白）。 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

const ARTICLE_SOURCES = ['hackernews', 'lobsters'] as const;

export function evaluateSources(
  rows: SourceDayRow[],
  trending: TrendingRow[],
): SourceVerdict[] {
  const trendingByDay = new Map<string, Set<string>>();
  for (const t of trending) {
    const set = trendingByDay.get(t.day) ?? new Set<string>();
    set.add(t.fullName.toLowerCase());
    trendingByDay.set(t.day, set);
  }

  const bySource = new Map<string, SourceDayRow[]>();
  for (const r of rows) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }

  const normalizedBySource = new Map<string, Map<string, Set<string>>>();
  for (const source of ARTICLE_SOURCES) {
    const byDay = new Map<string, Set<string>>();
    for (const r of bySource.get(source) ?? []) {
      const set = byDay.get(r.day) ?? new Set<string>();
      set.add(normalizeTitle(r.title));
      byDay.set(r.day, set);
    }
    normalizedBySource.set(source, byDay);
  }

  return ARTICLE_SOURCES.map((source): SourceVerdict => {
    const items = bySource.get(source) ?? [];
    const days = new Set(items.map((r) => r.day)).size;
    const dayCounts = new Map<string, number>();
    let overlap = 0;

    for (const r of items) {
      const repo = repoFromUrl(r.url);
      if (!repo) continue;
      dayCounts.set(r.day, (dayCounts.get(r.day) ?? 0) + 1);
      if (trendingByDay.get(r.day)?.has(repo)) overlap += 1;
    }

    const totalDays = [...dayCounts.values()];
    const githubPerDay = totalDays.length
      ? totalDays.reduce((a, b) => a + b, 0) / totalDays.length
      : 0;

    const ownTitles = normalizedBySource.get(source) ?? new Map<string, Set<string>>();
    const other = source === 'hackernews' ? 'lobsters' : 'hackernews';
    const otherTitles = normalizedBySource.get(other) ?? new Map<string, Set<string>>();
    let shared = 0;
    let ownTotal = 0;
    for (const [day, titles] of ownTitles) {
      const theirs = otherTitles.get(day) ?? new Set<string>();
      for (const title of titles) {
        ownTotal += 1;
        if (theirs.has(title)) shared += 1;
      }
    }

    const reasons: string[] = [];
    if (days < 14) reasons.push(`只有 ${days} 天数据，不足 14 天`);
    if (githubPerDay < 5) reasons.push(`每天指向仓库 ${githubPerDay.toFixed(2)} 条 < 5`);
    if (overlapRate(items, overlap) < 0.1) {
      reasons.push(`与 Trending 重合 ${(overlapRate(items, overlap) * 100).toFixed(1)}% < 10%`);
    }
    const crossDuplicateRate = ownTotal ? shared / ownTotal : 0;
    if (crossDuplicateRate >= 0.2) {
      reasons.push(`跨源重复 ${(crossDuplicateRate * 100).toFixed(1)}% >= 20%`);
    }

    return {
      source,
      days,
      total: items.length,
      githubPerDay,
      overlapRate: overlapRate(items, overlap),
      crossDuplicateRate,
      passed: reasons.length === 0,
      reasons,
    };
  });
}

function overlapRate(items: SourceDayRow[], overlap: number): number {
  return items.length ? overlap / items.length : 0;
}

async function main(): Promise<void> {
  const rows = await db()
    .select({
      source: sourceItems.source,
      day: sourceItems.capturedDate,
      url: sourceItems.url,
      title: sourceItems.title,
    })
    .from(sourceItems)
    .where(sql`${sourceItems.source} in ('hackernews', 'lobsters')`)
    .orderBy(sourceItems.capturedDate);

  const trending = await db()
    .select({ fullName: trendingEntries.fullName, day: trendingEntries.date })
    .from(trendingEntries);

  const verdicts = evaluateSources(rows, trending);

  console.log('=== HN / Lobsters 接入复评（ADR 0011）===');
  for (const v of verdicts) {
    console.log(`\n${v.source}: ${v.total} 条 / ${v.days} 天`);
    console.log(`  指向仓库: ${v.githubPerDay.toFixed(2)} 条/天  (阈值 >= 5)`);
    console.log(`  Trending 重合: ${(v.overlapRate * 100).toFixed(1)}%  (阈值 >= 10%)`);
    console.log(`  跨源重复: ${(v.crossDuplicateRate * 100).toFixed(1)}%  (阈值 < 20%)`);
    console.log(`  结论: ${v.passed ? 'PASS — 可考虑接入面板「社区热议」栏目' : 'FAIL'}`);
    for (const reason of v.reasons) console.log(`    - ${reason}`);
  }
  const anyPass = verdicts.some((v) => v.passed);
  console.log(
    `\n建议: ${anyPass
      ? '达标源可作为「社区热议」附加信号接入面板；仍不建议作为独立仓库卡片推送。'
      : '维持现状——文章源只入库、不推送，下次复评再查。'
    }`,
  );
}

if (process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
