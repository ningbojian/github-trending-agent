import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 口味信号：收藏（自动）+ 感兴趣/不感兴趣（显式）。
 * db 层用替身：`select().from()` 按表名分流，不连库。
 */
const dbMock = vi.hoisted(() => ({
  kvRows: [] as Array<{ value: unknown; expiresAt: Date }>,
  starRows: [] as Array<{ fullName: string; language: string | null; topics: unknown }>,
  selectError: false,
  writeError: false,
  insertValues: [] as Record<string, unknown>[],
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: (table: { _: { name: string } }) => ({
        leftJoin: () => ({
          where: async () => {
            if (dbMock.selectError) throw new Error('db down');
            return dbMock.starRows;
          },
        }),
        where: () => ({
          limit: async () => {
            if (dbMock.selectError) throw new Error('db down');
            return dbMock.kvRows;
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if (dbMock.writeError) throw new Error('db down');
        dbMock.insertValues.push(row);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

import {
  composeSignals,
  dominantSignals,
  emptySignals,
  FEEDBACK_MAX_EVENTS,
  FEEDBACK_TTL_MS,
  feedbackWeights,
  loadUserSignals,
  rankByTaste,
  readFeedback,
  recordFeedback,
  tasteWeight,
  type DigestCandidate,
  type FeedbackEvent,
  type StarRow,
} from '../src/agent/taste';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026-10-27 10:00 北京时间。 */
const NOW = new Date('2026-10-27T02:00:00.000Z');

function candidate(
  fullName: string,
  language: string | null,
  topics: string[] = [],
): DigestCandidate {
  return { fullName, language, topics };
}

function event(
  kind: 'like' | 'dislike',
  languages: string[],
  topics: string[] = [],
  at = NOW.toISOString(),
): FeedbackEvent {
  return { at, kind, languages, topics };
}

function star(fullName: string, language: string | null, topics: unknown = []): StarRow {
  return { fullName, language, topics };
}

beforeEach(() => {
  dbMock.kvRows = [];
  dbMock.starRows = [];
  dbMock.selectError = false;
  dbMock.writeError = false;
  dbMock.insertValues = [];
});

describe('emptySignals', () => {
  it('空画像：什么也不提升、什么也不屏蔽、没有收藏', () => {
    const signals = emptySignals();
    expect(signals.starred.size).toBe(0);
    expect(signals.languageBoost.size).toBe(0);
    expect(signals.topicBoost.size).toBe(0);
    expect(signals.suppressed.size).toBe(0);
  });
});

describe('dominantSignals', () => {
  it('语言取这批里最多的两门（不按出现顺序，按次数）', () => {
    const items = [
      candidate('a/1', 'Go'),
      candidate('a/2', 'python'),
      candidate('a/3', 'go'),
      candidate('a/4', 'rust'),
      candidate('a/5', 'GO'),
    ];
    expect(dominantSignals(items).languages).toEqual(['go', 'python']);
  });

  it('并列时按名字排序，保证同一批永远给出同一结果', () => {
    const items = [candidate('a/1', 'Rust'), candidate('a/2', 'Go'), candidate('a/3', 'C')];
    expect(dominantSignals(items).languages).toEqual(['c', 'go']);
  });

  it('话题取前三个，语言为空/缺失时跳过但不影响话题', () => {
    const items = [
      candidate('a/1', null, ['llm', 'rag', 'agent', 'db']),
      candidate('a/2', '', ['llm', 'rag']),
      candidate('a/3', null, ['llm']),
    ];
    const signals = dominantSignals(items);
    expect(signals.languages).toEqual([]);
    expect(signals.topics).toEqual(['llm', 'rag', 'agent']);
  });

  it('语言全为空 → 空数组（调用方据此回退通用文案）', () => {
    expect(dominantSignals([candidate('a/1', null), candidate('a/2', '')]).languages).toEqual(
      [],
    );
  });
});

describe('feedbackWeights', () => {
  it('like +1 / dislike -1，按事件累加', () => {
    const weights = feedbackWeights([
      event('dislike', ['go']),
      event('dislike', ['go', 'rust']),
      event('like', ['rust']),
    ]);
    expect(weights.languages.get('go')).toBe(-2);
    expect(weights.languages.get('rust')).toBe(0);
  });

  it('权重夹在 -3..3（十次操作也不让它变成十倍权重）', () => {
    const events = Array.from({ length: 8 }, () => event('dislike', ['go']));
    expect(feedbackWeights(events).languages.get('go')).toBe(-3);

    const likes = Array.from({ length: 8 }, () => event('like', ['go']));
    expect(feedbackWeights(likes).languages.get('go')).toBe(3);
  });

  it('话题权重单独计算，夹在 -2..2', () => {
    const events = Array.from({ length: 5 }, () => event('like', [], ['llm']));
    expect(feedbackWeights(events).topics.get('llm')).toBe(2);
  });
});

describe('composeSignals', () => {
  it('收藏 ≥2 个同语言才算偏好；1 个是偶然，按 0 处理', () => {
    const signals = composeSignals(
      [star('a/1', 'Go'), star('a/2', 'go'), star('a/3', 'Rust')],
      [],
    );
    expect(signals.languageBoost.get('go')).toBe(2);
    expect(signals.languageBoost.get('rust')).toBeUndefined();
  });

  it('收藏 boost 上限 3（收藏 10 个 Go 也不会把权重变成 10）', () => {
    const rows = Array.from({ length: 10 }, (_, i) => star(`a/${i}`, 'go'));
    expect(composeSignals(rows, []).languageBoost.get('go')).toBe(3);
  });

  it('收藏全部进 starred（含 repos 里查不到的），语言为空的不进 boost', () => {
    const signals = composeSignals([star('gone/repo', null)], []);
    expect(signals.starred.has('gone/repo')).toBe(true);
    expect(signals.languageBoost.size).toBe(0);
  });

  it('两次「不感兴趣」→ 该语言进 suppressed；两次「感兴趣」→ 退出来', () => {
    const disliked = composeSignals([], [event('dislike', ['go']), event('dislike', ['go'])]);
    expect(disliked.suppressed.has('go')).toBe(true);

    const restored = composeSignals([], [
      event('dislike', ['go']),
      event('dislike', ['go']),
      event('like', ['go']),
      event('like', ['go']),
    ]);
    expect(restored.suppressed.has('go')).toBe(false);
  });

  it('收藏与反馈叠加（收藏 go×2 + 一次 like → 3），反馈的负值也能把收藏的正值抵掉', () => {
    const both = composeSignals([star('a/1', 'go'), star('a/2', 'go')], [event('like', ['go'])]);
    expect(both.languageBoost.get('go')).toBe(3);

    const offset = composeSignals([star('a/1', 'go'), star('a/2', 'go')], [
      event('dislike', ['go']),
      event('dislike', ['go']),
    ]);
    expect(offset.languageBoost.get('go')).toBe(0);
  });

  it('收藏的 topics 上限 2', () => {
    const signals = composeSignals(
      [star('a/1', 'go', ['llm', 'rag', 'agent'])],
      [],
    );
    expect(signals.topicBoost.get('llm')).toBe(1);
  });
});

describe('tasteWeight / rankByTaste', () => {
  it('语言 boost + 话题 boost；话题贡献最多 ±2', () => {
    const signals = composeSignals(
      [star('a/1', 'go'), star('a/2', 'go')],
      [event('like', [], ['llm', 'rag', 'agent'])],
    );
    const goMany = candidate('x/1', 'go', ['llm', 'rag', 'agent', 'db']);
    // 语言 +2；话题 +1+1+1=3，夹到 +2。
    expect(tasteWeight(goMany, signals)).toBe(4);
  });

  it('没有任何信号时权重为 0（不因为话题多就自抬）', () => {
    const goMany = candidate('x/1', 'go', ['llm', 'rag', 'agent', 'db']);
    expect(tasteWeight(goMany, emptySignals())).toBe(0);
  });

  it('稳定排序：权重相同保持原顺序（原顺序已是 stars_delta DESC）', () => {
    const signals = composeSignals([star('a/1', 'go'), star('a/2', 'go')], []);
    const items = [candidate('x/1', 'rust'), candidate('x/2', 'go'), candidate('x/3', 'python')];
    expect(rankByTaste(items, signals).map((i) => i.fullName)).toEqual([
      'x/2',
      'x/1',
      'x/3',
    ]);
  });

  it('不丢弃任何条目（排序层只排不删）', () => {
    const items = [candidate('x/1', 'go'), candidate('x/2', 'go'), candidate('x/3', 'go')];
    expect(rankByTaste(items, emptySignals())).toHaveLength(3);
  });
});

describe('readFeedback', () => {
  it('超期行当作没有（TTL 之外的历史不参与权重）', async () => {
    dbMock.kvRows = [
      { value: { events: [event('dislike', ['go'])] }, expiresAt: new Date(NOW.getTime() - 1) },
    ];
    await expect(readFeedback('u1', NOW)).resolves.toEqual([]);
  });

  it('坏形状 / 未知 kind 的事件被丢掉，不抛', async () => {
    dbMock.kvRows = [
      {
        value: {
          events: [
            event('like', ['go']),
            { at: NOW.toISOString(), kind: 'meh', languages: ['rust'], topics: [] },
            { nope: true },
            'garbage',
          ],
        },
        expiresAt: new Date(NOW.getTime() + DAY_MS),
      },
    ];
    const events = await readFeedback('u1', NOW);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('like');
  });

  it('value 整体坏掉 → 空数组', async () => {
    dbMock.kvRows = [{ value: 'not-an-object', expiresAt: new Date(NOW.getTime() + DAY_MS) }];
    await expect(readFeedback('u1', NOW)).resolves.toEqual([]);
  });

  it('读库失败 → 空数组（画像读不到就不能把推送弄挂）', async () => {
    dbMock.selectError = true;
    await expect(readFeedback('u1', NOW)).resolves.toEqual([]);
  });
});

describe('recordFeedback', () => {
  it('追加一条事件并写 upsert，带 180 天过期', async () => {
    const items = [candidate('a/1', 'go'), candidate('a/2', 'go'), candidate('a/3', 'rust')];

    const affected = await recordFeedback('u1', 'dislike', items, NOW);

    expect(affected).toEqual({ languages: ['go', 'rust'], topics: [] });
    expect(dbMock.insertValues).toHaveLength(1);
    const row = dbMock.insertValues[0] as {
      key: string;
      value: { events: FeedbackEvent[] };
      expiresAt: Date;
    };
    expect(row.key).toBe('taste:u1');
    expect(row.value.events).toHaveLength(1);
    expect(row.value.events[0].kind).toBe('dislike');
    expect(row.value.events[0].languages).toEqual(['go', 'rust']);
    expect(FEEDBACK_TTL_MS).toBe(180 * DAY_MS);
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(FEEDBACK_TTL_MS);
  });

  it(`只保留最近 ${FEEDBACK_MAX_EVENTS} 条（旧信号自然滚出窗口）`, async () => {
    dbMock.kvRows = [
      {
        value: {
          events: Array.from({ length: FEEDBACK_MAX_EVENTS }, () => event('like', ['rust'])),
        },
        expiresAt: new Date(NOW.getTime() + DAY_MS),
      },
    ];

    await recordFeedback('u1', 'dislike', [candidate('a/1', 'go')], NOW);

    const row = dbMock.insertValues[0] as { value: { events: FeedbackEvent[] } };
    expect(row.value.events).toHaveLength(FEEDBACK_MAX_EVENTS);
    expect(row.value.events.at(-1)?.kind).toBe('dislike');
  });

  it('写失败要抛（回执不能谎称「记下了」）', async () => {
    dbMock.writeError = true;
    await expect(
      recordFeedback('u1', 'like', [candidate('a/1', 'go')], NOW),
    ).rejects.toThrow();
  });
});

describe('loadUserSignals', () => {
  it('收藏 + 反馈合并成一份画像', async () => {
    dbMock.starRows = [star('a/1', 'go'), star('a/2', 'go')];
    dbMock.kvRows = [
      {
        value: { events: [event('dislike', ['rust']), event('dislike', ['rust'])] },
        expiresAt: new Date(NOW.getTime() + DAY_MS),
      },
    ];

    const signals = await loadUserSignals('u1', NOW);

    expect(signals.starred.has('a/1')).toBe(true);
    expect(signals.languageBoost.get('go')).toBe(2);
    expect(signals.suppressed.has('rust')).toBe(true);
  });

  it('join 失败 → 只保留反馈信号，不抛', async () => {
    dbMock.selectError = true;
    const signals = await loadUserSignals('u1', NOW);
    expect(signals.starred.size).toBe(0);
    expect(signals.languageBoost.size).toBe(0);
  });
});
