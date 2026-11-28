import { describe, expect, it } from 'vitest';
import { evaluateSources, repoFromUrl, type SourceDayRow, type TrendingRow } from '../evals/eval-sources.js';

describe('repoFromUrl', () => {
  it('extracts owner/repo from a plain repo URL', () => {
    expect(repoFromUrl('https://github.com/vercel/next.js')).toBe('vercel/next.js');
  });

  it('normalizes case and strips query/hash', () => {
    expect(repoFromUrl('https://github.com/Vercel/Next.js?tab=stars#x')).toBe('vercel/next.js');
  });

  it('rejects gist, blob, tree and org pages', () => {
    expect(repoFromUrl('https://gist.github.com/u/abc')).toBeNull();
    expect(repoFromUrl('https://github.com/u/r/blob/master/a.md')).toBe('u/r');
    expect(repoFromUrl('https://github.com/orgs/foo')).toBeNull();
  });

  it('rejects non-github URLs', () => {
    expect(repoFromUrl('https://news.ycombinator.com/item?id=1')).toBeNull();
  });
});

describe('evaluateSources', () => {
  const days = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);

  function rowsFor(source: string, perDay: number): SourceDayRow[] {
    return days.flatMap((day) =>
      Array.from({ length: perDay }, (_, i) => ({
        source,
        day,
        url: `https://example.com/${source}/${day}/${i}`,
        title: `${source} story ${day} ${i}`,
      })),
    );
  }

  it('fails when GitHub links are below 5 per day', () => {
    const rows = [
      ...days.flatMap((day) => Array.from({ length: 6 }, (_, i) => ({
        source: 'hackernews' as const,
        day,
        url: i === 0 ? `https://github.com/o${i}/r${day}` : `https://example.com/${i}`,
        title: `hn ${day} ${i}`,
      }))),
      ...rowsFor('lobsters', 6),
    ];
    const verdicts = evaluateSources(rows, []);
    const hn = verdicts.find((v) => v.source === 'hackernews')!;
    expect(hn.passed).toBe(false);
    expect(hn.reasons.some((r) => r.includes('指向仓库'))).toBe(true);
  });

  it('passes a source meeting all three thresholds', () => {
    const rows: SourceDayRow[] = days.flatMap((day) =>
      Array.from({ length: 10 }, (_, i) => ({
        source: 'hackernews',
        day,
        url: `https://github.com/o${i}/repo-${day}`,
        title: `hn ${day} ${i}`,
      })),
    );
    const trending: TrendingRow[] = days.flatMap((day) =>
      Array.from({ length: 10 }, (_, i) => ({ day, fullName: `o${i}/repo-${day}` })),
    );
    const verdicts = evaluateSources(rows, trending);
    const hn = verdicts.find((v) => v.source === 'hackernews')!;
    expect(hn.passed).toBe(true);
    expect(hn.overlapRate).toBe(1);
  });

  it('reports insufficient data when fewer than 14 days', () => {
    const rows: SourceDayRow[] = days.slice(0, 3).flatMap((day) =>
      Array.from({ length: 10 }, (_, i) => ({
        source: 'lobsters',
        day,
        url: `https://github.com/o${i}/r${day}`,
        title: `lob ${day} ${i}`,
      })),
    );
    const verdicts = evaluateSources(rows, []);
    const lob = verdicts.find((v) => v.source === 'lobsters')!;
    expect(lob.reasons.some((r) => r.includes('不足 14 天'))).toBe(true);
  });
});
