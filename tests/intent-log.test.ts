import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 匿名意图日志：只记「规则层没判出来、但值得回头补规则」的那一小撮。
 * db 层用替身，不连库。
 */
const dbMock = vi.hoisted(() => ({
  throwOnWrite: false,
  insertValues: [] as Record<string, unknown>[],
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    insert: () => ({
      values: (row: unknown) => {
        if (dbMock.throwOnWrite) throw new Error('db down');
        dbMock.insertValues.push(row as Record<string, unknown>);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

import {
  INTENT_LOG_MAX_CHARS,
  INTENT_LOG_TTL_MS,
  intentMissKey,
  recordIntentMiss,
  shouldLogMiss,
} from '../src/agent/intent-log';
import { normalizeQueryText } from '../src/agent/query-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026-10-26 10:00 北京时间。 */
const NOW = new Date('2026-10-26T02:00:00.000Z');

beforeEach(() => {
  dbMock.throwOnWrite = false;
  dbMock.insertValues = [];
});

describe('shouldLogMiss', () => {
  it('最终判成 about / off_topic → 记（规则漏判了）', () => {
    expect(
      shouldLogMiss({
        ruleIntent: null,
        finalIntent: 'about',
        resultCount: 0,
        text: '你这个东西是谁做的',
      }),
    ).toBe(true);
    expect(
      shouldLogMiss({
        ruleIntent: null,
        finalIntent: 'off_topic',
        resultCount: 0,
        text: '今天股市怎么样啊兄弟',
      }),
    ).toBe(true);
  });

  it('规则已命中（ruleIntent 非空）且最终一致 → 不记', () => {
    expect(
      shouldLogMiss({
        ruleIntent: 'off_topic',
        finalIntent: 'off_topic',
        resultCount: 0,
        text: '今天股市怎么样',
      }),
    ).toBe(false);
  });

  it('搜不到东西（0 条结果）→ 记（多半是没听懂）', () => {
    expect(
      shouldLogMiss({
        ruleIntent: null,
        finalIntent: 'search',
        resultCount: 0,
        text: '那个最近很火的那个啥来着',
      }),
    ).toBe(true);
  });

  it('短句（≤10 字）→ 记，哪怕有结果', () => {
    expect(
      shouldLogMiss({
        ruleIntent: null,
        finalIntent: 'search',
        resultCount: 8,
        text: 'rust 热榜',
      }),
    ).toBe(true);
  });

  it('短句边界：正好 10 字记，11 字不记', () => {
    const ten = '一二三四五六七八九十'; // 10 字
    const eleven = '一二三四五六七八九十一'; // 11 字
    const base = { ruleIntent: null, finalIntent: 'search' as const, resultCount: 8 };
    expect(shouldLogMiss({ ...base, text: ten })).toBe(true);
    expect(shouldLogMiss({ ...base, text: eleven })).toBe(false);
  });

  it('正常搜索（规则没命中但有结果、也不是短句）→ 不记', () => {
    expect(
      shouldLogMiss({
        ruleIntent: null,
        finalIntent: 'search',
        resultCount: 6,
        text: '本周 rust 的 ai 项目有哪些',
      }),
    ).toBe(false);
  });
});

describe('intentMissKey', () => {
  it('同日同句（空白不同也算同句）→ 同一个 key', () => {
    expect(intentMissKey(' 本周  rust 项目 ', NOW)).toBe(
      intentMissKey('本周 rust 项目', NOW),
    );
  });

  it('同句不同日 → 不同 key（按天分桶，天然限流）', () => {
    const nextDay = new Date(NOW.getTime() + DAY_MS);
    expect(intentMissKey('rust 热榜', NOW)).not.toBe(
      intentMissKey('rust 热榜', nextDay),
    );
  });

  it('日期按北京时间分桶（UTC 日期不同但北京日期相同 → 同一个 key）', () => {
    // 2026-10-25T16:30Z = 2026-10-26 00:30 北京
    const justAfterShanghaiMidnight = new Date('2026-10-25T16:30:00.000Z');
    const shanghaiMorning = new Date('2026-10-26T02:00:00.000Z');
    expect(intentMissKey('rust', justAfterShanghaiMidnight)).toBe(
      intentMissKey('rust', shanghaiMorning),
    );
  });

  it('形状：intent-miss:yyyyMMdd:sha1(归一化文本)', () => {
    const digest = createHash('sha1')
      .update(normalizeQueryText('  rust 热榜 '))
      .digest('hex');
    expect(intentMissKey('  rust 热榜 ', NOW)).toBe(
      `intent-miss:20261026:${digest}`,
    );
  });
});

describe('recordIntentMiss', () => {
  it('写一条匿名记录：截断 60 字、带最终意图、120 天过期、不含 userid', async () => {
    const long = '啊'.repeat(200);

    await recordIntentMiss(long, 'off_topic', NOW);

    expect(dbMock.insertValues).toHaveLength(1);
    const row = dbMock.insertValues[0] as {
      key: string;
      value: Record<string, unknown>;
      expiresAt: Date;
    };
    expect(row.key).toBe(intentMissKey(long, NOW));
    expect(Object.keys(row.value).sort()).toEqual(['final', 'text']);
    expect(row.value.final).toBe('off_topic');
    expect(Array.from(String(row.value.text))).toHaveLength(INTENT_LOG_MAX_CHARS);
    expect(INTENT_LOG_TTL_MS).toBe(120 * DAY_MS);
    const ttl = row.expiresAt.getTime() - NOW.getTime();
    expect(ttl).toBe(INTENT_LOG_TTL_MS);
  });

  it('写失败不抛（日志永远不能把搜索弄挂）', async () => {
    dbMock.throwOnWrite = true;

    await expect(
      recordIntentMiss('rust 热榜', 'search', NOW),
    ).resolves.toBeUndefined();
  });
});
