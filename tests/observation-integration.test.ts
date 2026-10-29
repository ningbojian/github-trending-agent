import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 今日观察的集成层：缓存、7 天历史、失败语义、每人每日标记。
 * 全部打桩（db / LLM），不触网、不连库。
 */

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  executeQueue: [] as unknown[],
  insertCalls: [] as Record<string, unknown>[],
}));

const llmMock = vi.hoisted(() => ({
  generateObjectSafe: vi.fn(),
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          const next = dbMock.selectQueue.shift() ?? [];
          if (next instanceof Error) throw next;
          return next;
        },
      }),
    }),
    execute: async () => {
      const next = dbMock.executeQueue.shift() ?? [];
      if (next instanceof Error) throw next;
      return { rows: next };
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbMock.insertCalls.push(values);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: llmMock.generateObjectSafe,
}));

import {
  getDailyObservations,
} from '../src/agent/observation';

const NOW = new Date('2026-10-29T01:00:00Z'); // 北京 09:00
const DATA_DATE = '2026-10-29';

function factRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fullName: 'acme/rocket',
    language: 'rust',
    topics: ['cli'],
    stars: 5000,
    deltaToday: 500,
    deltaPrev: 100,
    prevRank: 10,
    rankToday: 3,
    daysOnList: 1,
    firstSeenDate: DATA_DATE,
    isNew: true,
    historyDepth: 3,
    ...overrides,
  };
}

function snapshot(items = [{ fullName: 'acme/rocket' }]) {
  return {
    date: DATA_DATE,
    dataDate: DATA_DATE,
    abstract: null,
    items: items.map((item) => ({
      fullName: item.fullName,
      description: null,
      topics: [],
      language: 'rust',
      stars: 5000,
      starsDelta: 500,
      isNew: true,
      htmlUrl: `https://github.com/${item.fullName}`,
      summary: '极快工具',
      short: '跑得快',
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectQueue.length = 0;
  dbMock.executeQueue.length = 0;
  dbMock.insertCalls.length = 0;
});

describe('getDailyObservations — 缓存', () => {
  it('同 dataDate 的缓存直接返回，不再查历史/调模型', async () => {
    dbMock.selectQueue.push([
      {
        key: `observation:v1:${DATA_DATE}`,
        value: {
          date: DATA_DATE,
          dataDate: DATA_DATE,
          lines: [
            { kind: 'acceleration', signature: 'repo:a/one', claim: 'a/one 加速', evidence: ['a/one', 'a/two'] },
            { kind: 'streak', signature: 'repo:b/one', claim: 'b/one 连续在榜', evidence: ['b/one', 'b/two'] },
          ],
          message: '今日观察（10-29）\n1. a/one 加速\n2. b/one 连续在榜',
        },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);

    const result = await getDailyObservations(snapshot() as never, NOW);

    expect(result?.message).toContain('今日观察');
    expect(dbMock.executeQueue).toHaveLength(0);
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
  });

  it('dataDate 变化时重建（不用旧缓存）', async () => {
    dbMock.selectQueue.push([
      {
        key: `observation:v1:${DATA_DATE}`,
        value: { date: DATA_DATE, dataDate: '2026-10-28', lines: [], message: null },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    dbMock.selectQueue.push([]); // 历史
    dbMock.executeQueue.push([factRow()]);
    dbMock.executeQueue.push([]); // themes
    llmMock.generateObjectSafe.mockResolvedValue({ observations: [] });

    const result = await getDailyObservations(snapshot() as never, NOW);

    expect(result?.message).toBeNull();
    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
  });
});

describe('getDailyObservations — 失败语义', () => {
  it('历史读取失败 → fail closed：不生成、不缓存、不调模型', async () => {
    dbMock.selectQueue.push([]); // 无缓存
    dbMock.selectQueue.push(new Error('db down'));

    const result = await getDailyObservations(snapshot() as never, NOW);

    expect(result).toBeNull();
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('没有候选 → 缓存空结果，不调模型', async () => {
    dbMock.selectQueue.push([]);
    dbMock.selectQueue.push([]);
    dbMock.executeQueue.push([]);
    dbMock.executeQueue.push([]);

    const result = await getDailyObservations(snapshot() as never, NOW);

    expect(result?.message).toBeNull();
    expect(result?.lines).toEqual([]);
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(dbMock.insertCalls.some((call) => call.key === `observation:v1:${DATA_DATE}`)).toBe(
      true,
    );
  });

  it('模型返回 null → 缓存空结果，简报不受影响', async () => {
    dbMock.selectQueue.push([]);
    dbMock.selectQueue.push([]);
    dbMock.executeQueue.push([factRow()]);
    dbMock.executeQueue.push([]);
    llmMock.generateObjectSafe.mockResolvedValue(null);

    const result = await getDailyObservations(snapshot() as never, NOW);

    expect(result?.message).toBeNull();
    expect(dbMock.insertCalls.some((call) => call.key === `observation:v1:${DATA_DATE}`)).toBe(
      true,
    );
  });
});

describe('getDailyObservations — 正常生成', () => {
  it('两条候选 → 两条观察；证据与数字校验后渲染成文本', async () => {
    dbMock.selectQueue.push([]); // 无缓存
    dbMock.selectQueue.push([]); // 无历史
    dbMock.executeQueue.push([
      factRow({ fullName: 'a/one' }),
      factRow({ fullName: 'b/two' }),
    ]);
    dbMock.executeQueue.push([]);
    llmMock.generateObjectSafe.mockResolvedValue({
      observations: [
        { candidate: 1, claim: 'a/one 今天 +500，新项目集中爆发' },
        { candidate: 2, claim: 'b/two 今天 +500，同方向继续升温' },
      ],
    });

    const result = await getDailyObservations(snapshot() as never, NOW);

    expect(result?.lines).toHaveLength(2);
    expect(result?.message).toContain('a/one');
    expect(result?.message).toContain('b/two');
    const written = dbMock.insertCalls.find(
      (call) => call.key === `observation:v1:${DATA_DATE}`,
    );
    expect(written?.value).toMatchObject({ dataDate: DATA_DATE });
    // 面板历史：同一次生成顺带写 30 天归档。
    expect(dbMock.insertCalls.some((call) => call.key === `archive:v1:${DATA_DATE}`)).toBe(
      true,
    );
  });
});
