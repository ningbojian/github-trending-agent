import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  env: {},
  SCRAPER_LANGUAGES: [
    'python',
    'typescript',
    'javascript',
    'go',
    'rust',
    'java',
    'c',
    'c++',
    'c#',
    'php',
    'ruby',
    'swift',
    'kotlin',
    'dart',
    'shell',
    'html',
    'css',
    'vue',
    'lua',
  ],
}));

import {
  EMAIL_DEFAULT_DIGEST_COUNT,
  EMAIL_DEFAULT_INTERVAL_DAYS,
  EMAIL_DEFAULT_PUSH_TIME,
  EMAIL_DIGEST_COUNTS,
  EMAIL_INTERVALS,
  EMAIL_MAX_KEYWORDS,
  EMAIL_PUSH_TIMES,
  normalizeEmailKeywords,
  normalizeEmailLanguages,
  normalizeEmailPreferences,
  validateEmailPreferencesInput,
} from '../src/email/preferences';

describe('constants', () => {
  it('locks the push window, intervals and counts to the plan', () => {
    expect(EMAIL_DEFAULT_PUSH_TIME).toBe('09:00');
    expect(EMAIL_DEFAULT_INTERVAL_DAYS).toBe(1);
    expect(EMAIL_DEFAULT_DIGEST_COUNT).toBe(15);
    expect([...EMAIL_PUSH_TIMES]).toEqual([
      '09:00',
      '10:00',
      '11:00',
      '12:00',
      '13:00',
      '14:00',
      '15:00',
      '16:00',
      '17:00',
    ]);
    expect([...EMAIL_INTERVALS]).toEqual([1, 2, 3, 7]);
    expect([...EMAIL_DIGEST_COUNTS]).toEqual([5, 10, 15, 20]);
    expect(EMAIL_MAX_KEYWORDS).toBe(10);
  });
});

describe('normalizeEmailLanguages', () => {
  it('keeps known slugs, lowercases, trims and dedupes', () => {
    expect(
      normalizeEmailLanguages([' Python ', 'RUST', 'python', 'brainfuck', 42]),
    ).toEqual(['python', 'rust']);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeEmailLanguages(undefined)).toEqual([]);
    expect(normalizeEmailLanguages('rust')).toEqual([]);
  });
});

describe('normalizeEmailKeywords', () => {
  it('splits strings on Chinese and ASCII commas', () => {
    expect(normalizeEmailKeywords('AI，开发效率, rust')).toEqual([
      'ai',
      '开发效率',
      'rust',
    ]);
  });

  it('strips punctuation, dedupes and caps at 10 entries', () => {
    const many = Array.from({ length: 15 }, (_, index) => `kw${index}！`);
    const cleaned = normalizeEmailKeywords(many);
    expect(cleaned).toHaveLength(10);
    expect(cleaned[0]).toBe('kw0');
    expect(normalizeEmailKeywords(['AI?', 'ai'])).toEqual(['ai']);
  });
});

describe('normalizeEmailPreferences', () => {
  it('returns the documented defaults for garbage input', () => {
    expect(normalizeEmailPreferences(null)).toEqual({
      pushTime: '09:00',
      intervalDays: 1,
      digestCount: 15,
      languages: [],
      keywords: [],
    });
  });

  it('rejects out-of-window times and unsupported intervals/counts', () => {
    const prefs = normalizeEmailPreferences({
      pushTime: '08:00',
      intervalDays: 4,
      digestCount: 7,
    });
    expect(prefs.pushTime).toBe('09:00');
    expect(prefs.intervalDays).toBe(1);
    expect(prefs.digestCount).toBe(15);
  });

  it('accepts every valid window value', () => {
    const prefs = normalizeEmailPreferences({
      pushTime: '17:00',
      intervalDays: 7,
      digestCount: 20,
    });
    expect(prefs).toMatchObject({
      pushTime: '17:00',
      intervalDays: 7,
      digestCount: 20,
    });
  });
});

describe('validateEmailPreferencesInput', () => {
  it('defaults missing fields', () => {
    const result = validateEmailPreferencesInput({});
    expect(result).toEqual({
      ok: true,
      preferences: {
        pushTime: '09:00',
        intervalDays: 1,
        digestCount: 15,
        languages: [],
        keywords: [],
      },
    });
  });

  it('rejects non-hourly / out-of-window push times', () => {
    for (const pushTime of ['08:00', '17:30', '18:00', '9:00', 'abc']) {
      const result = validateEmailPreferencesInput({ pushTime });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('09:00–17:00');
    }
  });

  it('rejects unsupported intervals and counts', () => {
    const badInterval = validateEmailPreferencesInput({ intervalDays: '4' });
    expect(badInterval.ok).toBe(false);
    if (!badInterval.ok) expect(badInterval.error).toContain('间隔');

    const badCount = validateEmailPreferencesInput({ digestCount: '7' });
    expect(badCount.ok).toBe(false);
    if (!badCount.ok) expect(badCount.error).toContain('条数');
  });

  it('normalizes languages and keywords on success', () => {
    const result = validateEmailPreferencesInput({
      pushTime: '17:00',
      intervalDays: '3',
      digestCount: '5',
      languages: ['PYTHON', 'brainfuck', 'rust'],
      keywords: 'AI！, 开发效率 ,ai',
    });
    expect(result).toEqual({
      ok: true,
      preferences: {
        pushTime: '17:00',
        intervalDays: 3,
        digestCount: 5,
        languages: ['python', 'rust'],
        keywords: ['ai', '开发效率'],
      },
    });
  });
});
