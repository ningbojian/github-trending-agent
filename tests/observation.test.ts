import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  buildObservationCandidates,
  buildThemeStats,
  composeObservationFactsSql,
  passesNoveltyGate,
  renderObservationMessage,
  validateObservationOutput,
  type ObservationCandidate,
  type ObservationFactRow,
  type ThemeCountRow,
} from '../src/agent/observation';

/**
 * 「今日观察」的核心规则。
 *
 * 这个模块存在的唯一理由：每天的观察必须讲「今天和过去有什么不同」，
 * 否则它会退化成一份换词复述的榜单。所以候选全部由代码从
 * trending_entries 的历史里算出来（新上榜 / 加速 / 连续在榜 / 主题变化），
 * 模型只负责把它写成一句人话；数字与仓库都做白名单校验。
 */

function row(overrides: Partial<ObservationFactRow> = {}): ObservationFactRow {
  return {
    fullName: 'acme/rocket',
    language: 'rust',
    topics: ['cli'],
    stars: 5000,
    deltaToday: 500,
    deltaPrev: 200,
    prevRank: 10,
    rankToday: 3,
    daysOnList: 1,
    firstSeenDate: '2026-10-29',
    isNew: true,
    ...overrides,
  };
}

const DATA_DATE = '2026-10-29';

function candidate(overrides: Partial<ObservationCandidate> = {}): ObservationCandidate {
  return {
    kind: 'acceleration',
    signature: 'repo:acme/rocket',
    mainRepo: 'acme/rocket',
    evidence: ['acme/rocket', 'acme/other'],
    facts: '加速：今天 +900，昨天 +300（3.0 倍）；stars 5000',
    score: 900,
    ...overrides,
  };
}

describe('候选判定 — 新上榜', () => {
  it('首次出现就是今天、且历史深度足够 → 新上榜', () => {
    const candidates = buildObservationCandidates(
      [row({ daysOnList: 1, firstSeenDate: DATA_DATE })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'new-entrant')).toBe(true);
  });

  it('历史深度不足 2 天时禁用新上榜——否则上线首日满屏都是「新」', () => {
    const candidates = buildObservationCandidates(
      [row({ daysOnList: 1, firstSeenDate: DATA_DATE })],
      [],
      { dataDate: DATA_DATE, historyDepth: 1 },
    );
    expect(candidates).toEqual([]);
  });
});

describe('候选判定 — 加速', () => {
  it('今天增量达到昨天 1.8 倍 → 加速', () => {
    const candidates = buildObservationCandidates(
      [row({ deltaToday: 360, deltaPrev: 200, daysOnList: 2, firstSeenDate: '2026-10-28' })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'acceleration')).toBe(true);
  });

  it('1.79 倍不算加速', () => {
    const candidates = buildObservationCandidates(
      [row({ deltaToday: 358, deltaPrev: 200, daysOnList: 2, firstSeenDate: '2026-10-28' })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'acceleration')).toBe(false);
  });

  it('前一天为 0 时，排名跃升至少 5 位且增量 ≥200 也算加速', () => {
    const candidates = buildObservationCandidates(
      [row({ deltaToday: 200, deltaPrev: 0, prevRank: 20, rankToday: 15, daysOnList: 2, firstSeenDate: '2026-10-28' })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'acceleration')).toBe(true);

    const weak = buildObservationCandidates(
      [row({ deltaToday: 199, deltaPrev: 0, prevRank: 20, rankToday: 15, daysOnList: 2, firstSeenDate: '2026-10-28' })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(weak.some((item) => item.kind === 'acceleration')).toBe(false);
  });
});

describe('候选判定 — 连续在榜', () => {
  it('连续 3 天且今天仍有增量 → 连续在榜', () => {
    const candidates = buildObservationCandidates(
      [row({ daysOnList: 3, firstSeenDate: '2026-10-27', deltaToday: 50 })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'streak')).toBe(true);
  });

  it('只待了 2 天不算连续在榜', () => {
    const candidates = buildObservationCandidates(
      [row({ daysOnList: 2, firstSeenDate: '2026-10-28', deltaToday: 500 })],
      [],
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'streak')).toBe(false);
  });
});

describe('候选判定 — 主题变化', () => {
  const themeRows: ThemeCountRow[] = [
    { theme: 'rust', kind: 'language', date: '2026-10-23', count: 2 },
    { theme: 'rust', kind: 'language', date: '2026-10-24', count: 2 },
    { theme: 'rust', kind: 'language', date: '2026-10-25', count: 2 },
    { theme: 'rust', kind: 'language', date: '2026-10-26', count: 2 },
    { theme: 'rust', kind: 'language', date: '2026-10-27', count: 2 },
    { theme: 'rust', kind: 'language', date: '2026-10-28', count: 2 },
    { theme: 'rust', kind: 'language', date: DATA_DATE, count: 6 },
  ];

  it('主题数量达到近 7 天均值的 1.5 倍且绝对增加 ≥2 → 主题变化', () => {
    const stats = buildThemeStats(themeRows, DATA_DATE);
    expect(stats.find((item) => item.theme === 'rust')?.ratio).toBeCloseTo(3);
    const candidates = buildObservationCandidates(
      [
        row({ fullName: 'a/one', language: 'rust', deltaToday: 300 }),
        row({ fullName: 'b/two', language: 'rust', deltaToday: 200 }),
        row({ fullName: 'c/three', language: 'rust', deltaToday: 100 }),
      ],
      themeRows,
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    const theme = candidates.find((item) => item.kind === 'theme-shift');
    expect(theme?.theme).toBe('rust');
    expect(theme?.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('主题只有 3 个但基线也高（不到 1.5 倍）时不算主题变化', () => {
    const rows: ThemeCountRow[] = Array.from({ length: 7 }, (_, i) => ({
      theme: 'python',
      kind: 'language',
      date: i === 6 ? DATA_DATE : `2026-10-2${3 + i}`,
      count: i === 6 ? 3 : 3,
    }));
    const candidates = buildObservationCandidates(
      [row({ language: 'python', deltaToday: 500 })],
      rows,
      { dataDate: DATA_DATE, historyDepth: 3 },
    );
    expect(candidates.some((item) => item.kind === 'theme-shift')).toBe(false);
  });
});

describe('候选排序与上限', () => {
  it('最多 10 个候选，按分数降序', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({
        fullName: `a/r${i}`,
        deltaToday: 1000 - i * 10,
        deltaPrev: 100,
        daysOnList: 2,
        firstSeenDate: '2026-10-28',
      }),
    );
    const candidates = buildObservationCandidates(rows, [], {
      dataDate: DATA_DATE,
      historyDepth: 3,
    });
    expect(candidates.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i - 1].score).toBeGreaterThanOrEqual(candidates[i].score);
    }
  });
});

describe('输出校验 — 数字与仓库白名单', () => {
  const candidates = [candidate()];

  it('把候选编号映射成签名与证据仓库', () => {
    const lines = validateObservationOutput(
      { observations: [{ candidate: 1, claim: 'acme/rocket 今天涨了 3 倍' }] },
      candidates,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].signature).toBe('repo:acme/rocket');
    expect(lines[0].evidence).toEqual(['acme/rocket', 'acme/other']);
  });

  it('claim 里的数字必须在事实白名单里，否则丢弃', () => {
    const lines = validateObservationOutput(
      { observations: [{ candidate: 1, claim: 'acme/rocket 今天涨了 7 倍' }] },
      candidates,
    );
    expect(lines).toEqual([]);
  });

  it('候选编号越界 → 丢弃', () => {
    const lines = validateObservationOutput(
      { observations: [{ candidate: 9, claim: 'acme/rocket 今天涨了 3 倍' }] },
      candidates,
    );
    expect(lines).toEqual([]);
  });

  it('最多保留 3 条', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      candidate({ signature: `repo:a/r${i}`, mainRepo: `a/r${i}`, evidence: [`a/r${i}`, 'a/x'] }),
    );
    const lines = validateObservationOutput(
      {
        observations: many.map((_, i) => ({ candidate: i + 1, claim: `a/r${i} 今天涨了 3 倍` })),
      },
      many,
    );
    expect(lines).toHaveLength(3);
  });
});

describe('防重复 — 7 天签名与证据门槛', () => {
  const recent = [
    {
      date: '2026-10-28',
      signatures: ['repo:acme/rocket'],
      evidence: ['acme/rocket', 'acme/other'],
    },
  ];

  it('相同签名出现过 → 丢弃', () => {
    expect(
      passesNoveltyGate(
        { kind: 'acceleration', signature: 'repo:acme/rocket', claim: 'x', evidence: ['acme/rocket'] },
        recent,
      ),
    ).toBe(false);
  });

  it('两个证据仓库都出现过 → 丢弃（即使签名不同）', () => {
    const line = {
      kind: 'theme-shift' as const,
      signature: 'theme:rust',
      claim: 'x',
      evidence: ['acme/rocket', 'acme/other'],
    };
    expect(passesNoveltyGate(line, recent)).toBe(false);
  });

  it('只有一个证据仓库重叠 → 允许（新语境）', () => {
    const line = {
      kind: 'theme-shift' as const,
      signature: 'theme:rust',
      claim: 'x',
      evidence: ['acme/rocket', 'new/repo'],
    };
    expect(passesNoveltyGate(line, recent)).toBe(true);
  });
});

describe('渲染', () => {
  const lines = [
    {
      kind: 'acceleration' as const,
      signature: 'repo:a/one',
      claim: 'a/one 与 a/two 同时加速',
      evidence: ['a/one', 'a/two'],
    },
    {
      kind: 'theme-shift' as const,
      signature: 'theme:rust',
      claim: 'Rust 工具今天集中上榜',
      evidence: ['b/one', 'b/two', 'b/three'],
    },
  ];

  it('输出两行观察；claim 里没提到的证据仓库补在行尾', () => {
    const text = renderObservationMessage(lines, '2026-10-29');
    expect(text).toContain('今日观察（10-29）');
    expect(text).toContain('1. a/one 与 a/two 同时加速');
    expect(text).toContain('2. Rust 工具今天集中上榜｜b/one、b/two、b/three');
  });

  it('少于 2 条不发', () => {
    expect(renderObservationMessage([lines[0]], '2026-10-29')).toBeNull();
  });

  it('超过字节上限时先删后面的行，删到只剩 1 条就返回 null', () => {
    const long = [
      ...lines,
      {
        kind: 'streak' as const,
        signature: 'repo:c/one',
        claim: '很长的观察'.repeat(30),
        evidence: ['c/one', 'c/two'],
      },
    ];
    const text = renderObservationMessage(long, '2026-10-29');
    expect(text).not.toBeNull();
    expect(Buffer.byteLength(text as string, 'utf8')).toBeLessThanOrEqual(600);
  });
});

describe('事实 SQL', () => {
  it('按数据日取 7 天窗口，并区分语言榜与总榜', () => {
    const query = new PgDialect().sqlToQuery(
      composeObservationFactsSql(DATA_DATE) as SQL,
    );
    expect(query.sql).toContain('trending_entries');
    expect(query.sql).toContain('distinct on');
    expect(query.params).toContain(DATA_DATE);
  });
});
