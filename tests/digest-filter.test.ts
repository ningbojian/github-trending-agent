import { describe, expect, it } from 'vitest';
import {
  applyHardFilters,
  GROWTH_MIN_DELTA,
  passesGrowth,
} from '../src/agent/digest-filter';
import { composeSignals, emptySignals, type DigestCandidate } from '../src/agent/taste';
import type { PushHistory } from '../src/agent/push-history';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T02:00:00.000Z');

interface Candidate extends DigestCandidate {
  starsDelta: number;
  isNew: boolean;
}

function item(fullName: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    fullName,
    language: 'Go',
    topics: ['cli'],
    starsDelta: 200,
    isNew: false,
    ...overrides,
  };
}

function pushed(items: Array<[string, number]>): PushHistory {
  return {
    items: items.map(([fullName, daysAgo]) => ({
      fullName,
      at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    })),
    lastSentAt: NOW.toISOString(),
  };
}

describe('passesGrowth', () => {
  it('新上过榜的仓库不看增量（isNew 直接通过）', () => {
    expect(passesGrowth({ fullName: 'a/b', starsDelta: 0, isNew: true })).toBe(true);
  });

  it(`达到 ${GROWTH_MIN_DELTA} 星才算明显增长：${GROWTH_MIN_DELTA - 1} 不过`, () => {
    expect(passesGrowth({ fullName: 'a/b', starsDelta: GROWTH_MIN_DELTA - 1, isNew: false })).toBe(
      false,
    );
    expect(passesGrowth({ fullName: 'a/b', starsDelta: GROWTH_MIN_DELTA, isNew: false })).toBe(true);
  });
});

describe('applyHardFilters', () => {
  it('收藏过的直接丢（用户已经知道了）', () => {
    const signals = composeSignals([{ fullName: 'a/1', language: 'Go', topics: [] }], []);
    const kept = applyHardFilters([item('a/1'), item('a/2')], {
      signals,
      history: null,
      now: NOW,
    });
    expect(kept.map((i) => i.fullName)).toEqual(['a/2']);
  });

  it('7 天内推过的丢，第 8 天放行', () => {
    const history = pushed([['a/1', 6], ['a/2', 8]]);
    const kept = applyHardFilters([item('a/1'), item('a/2')], {
      signals: emptySignals(),
      history,
      now: NOW,
    });
    expect(kept.map((i) => i.fullName)).toEqual(['a/2']);
  });

  it('被「不感兴趣」屏蔽的语言丢（大小写不敏感）', () => {
    const signals = composeSignals([], [
      { at: NOW.toISOString(), kind: 'dislike', languages: ['go'], topics: [] },
      { at: NOW.toISOString(), kind: 'dislike', languages: ['go'], topics: [] },
    ]);
    const kept = applyHardFilters(
      [item('a/1', { language: 'Go' }), item('a/2', { language: 'Rust' })],
      { signals, history: null, now: NOW },
    );
    expect(kept.map((i) => i.fullName)).toEqual(['a/2']);
  });

  it('没有画像没有历史 → 原样返回（顺序也不动）', () => {
    const items = [item('a/1'), item('a/2'), item('a/3')];
    const kept = applyHardFilters(items, { signals: emptySignals(), history: null, now: NOW });
    expect(kept).toEqual(items);
  });

  it('语言为 null 的条目不受屏蔽影响（无从判断，不误杀）', () => {
    const signals = composeSignals([], [
      { at: NOW.toISOString(), kind: 'dislike', languages: ['go'], topics: [] },
      { at: NOW.toISOString(), kind: 'dislike', languages: ['go'], topics: [] },
    ]);
    const kept = applyHardFilters([item('a/1', { language: null })], {
      signals,
      history: null,
      now: NOW,
    });
    expect(kept).toHaveLength(1);
  });
});
