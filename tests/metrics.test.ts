import { describe, expect, it } from 'vitest';
import {
  beijingDay,
  hashUserid,
  percentile,
  resolveDays,
  summarizeMetrics,
  METRICS_DEFAULT_DAYS,
  METRICS_MAX_DAYS,
} from '../src/obs/metrics';

/**
 * 度量看板的纯函数层：不碰数据库，输入是已经按时间窗取好的行。
 * 这些函数是「面试时能报出的数字」的生产者，所以边界用例必须钉住。
 */

function run(overrides: Partial<Parameters<typeof summarizeMetrics>[0][number]> = {}) {
  return {
    createdAt: new Date('2026-10-27T01:00:00.000Z'),
    kind: 'text',
    userid: 'alice',
    ok: true,
    totalMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    steps: [],
    ...overrides,
  };
}

function toolCall(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: new Date('2026-10-27T01:00:00.000Z'),
    tool: 'search_trending',
    status: 'ok',
    latencyMs: 50,
    ...overrides,
  };
}

describe('percentile', () => {
  it('空样本返回 0（页面显示 N/A，而不是 NaN）', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('单个样本返回它自己', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('nearest-rank：1..100 的 p50=50、p95=95', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
  });

  it('不要求输入有序，也不修改入参', () => {
    const values = [5, 1, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(values).toEqual([5, 1, 3]);
  });
});

describe('beijingDay', () => {
  it('UTC 20:00 已经算北京时间的第二天', () => {
    expect(beijingDay(new Date('2026-10-26T20:00:00.000Z'))).toBe('2026-10-27');
  });

  it('UTC 15:59 还是北京时间当天', () => {
    expect(beijingDay(new Date('2026-10-26T15:59:00.000Z'))).toBe('2026-10-26');
  });
});

describe('hashUserid', () => {
  it('同一个 userid 稳定、8 位十六进制', () => {
    const first = hashUserid('zhangsan');
    expect(first).toBe(hashUserid('zhangsan'));
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });

  it('不同 userid 不同哈希，且输出里不含原文', () => {
    expect(hashUserid('alice')).not.toBe(hashUserid('bob'));
    expect(hashUserid('alice')).not.toContain('alice');
  });
});

describe('resolveDays', () => {
  it('缺省 7 天', () => {
    expect(resolveDays(undefined)).toBe(METRICS_DEFAULT_DAYS);
    expect(resolveDays('')).toBe(METRICS_DEFAULT_DAYS);
    expect(resolveDays('abc')).toBe(METRICS_DEFAULT_DAYS);
    expect(resolveDays('0')).toBe(METRICS_DEFAULT_DAYS);
    expect(resolveDays('-3')).toBe(METRICS_DEFAULT_DAYS);
  });

  it('合法值原样、超上限夹到 30', () => {
    expect(resolveDays('14')).toBe(14);
    expect(resolveDays('9999')).toBe(METRICS_MAX_DAYS);
  });
});

describe('summarizeMetrics — 运行', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');

  it('按天补零、累计成功与失败、按 kind 计数', () => {
    const summary = summarizeMetrics(
      [
        run({ createdAt: new Date('2026-10-27T01:00:00.000Z') }),
        run({ createdAt: new Date('2026-10-27T02:00:00.000Z'), ok: false, kind: 'push' }),
        run({ createdAt: new Date('2026-10-26T01:00:00.000Z'), kind: 'event' }),
        run({ createdAt: new Date('2026-10-26T03:00:00.000Z'), kind: 'weird' }),
      ],
      [],
      { now, days: 3 },
    );

    expect(summary.windowDays).toBe(3);
    expect(summary.runs.total).toBe(4);
    expect(summary.runs.okRate).toBe(0.75);
    expect(summary.runs.byKind).toEqual({ text: 1, event: 1, push: 1, other: 1 });
    expect(summary.runs.perDay).toEqual([
      { day: '2026-10-25', total: 0, ok: 0, failed: 0 },
      { day: '2026-10-26', total: 2, ok: 2, failed: 0 },
      // 北京时间的 10-27 也包含 10-27T01:00Z / 02:00Z
      { day: '2026-10-27', total: 2, ok: 1, failed: 1 },
    ]);
  });

  it('p50/p95 与 token 汇总', () => {
    const summary = summarizeMetrics(
      [
        run({ totalMs: 100, inputTokens: 10, outputTokens: 2 }),
        run({ totalMs: 200, inputTokens: 20, outputTokens: 3 }),
        run({ totalMs: 300, inputTokens: 30, outputTokens: 4 }),
        run({ totalMs: 400, inputTokens: 40, outputTokens: 5 }),
      ],
      [],
      { now, days: 1 },
    );

    expect(summary.runs.latencyMs).toEqual({ p50: 200, p95: 400 });
    expect(summary.runs.tokens).toEqual({ input: 100, output: 14 });
  });

  it('没有运行时 okRate / latency 为 null（不输出 0 假装正常）', () => {
    const summary = summarizeMetrics([], [], { now, days: 1 });
    expect(summary.runs.okRate).toBeNull();
    expect(summary.runs.latencyMs).toBeNull();
    expect(summary.runs.total).toBe(0);
  });

  it('distinctUsers 用哈希，不泄露 userid', () => {
    const summary = summarizeMetrics(
      [run({ userid: 'alice' }), run({ userid: 'alice' }), run({ userid: 'bob' })],
      [],
      { now, days: 1 },
    );

    expect(summary.runs.distinctUsers).toBe(2);
    expect(JSON.stringify(summary)).not.toContain('alice');
    expect(JSON.stringify(summary)).not.toContain('bob');
  });

  it('steps 里统计路由与解析来源；坏 steps 不崩', () => {
    const summary = summarizeMetrics(
      [
        run({ steps: [{ ms: 0, name: 'handler', detail: 'handleSearch' }] }),
        run({ steps: [{ ms: 0, name: 'handler', detail: 'handleSearch' }] }),
        run({
          steps: [
            { ms: 0, name: 'handler', detail: 'handleSubscribe' },
            { ms: 10, name: 'parse-source', detail: 'llm' },
          ],
        }),
        run({ steps: 'oops' }),
        run({ steps: [null, { name: 'parse-source', detail: 'cache' }] }),
      ],
      [],
      { now, days: 1 },
    );

    expect(summary.routes).toEqual([
      { name: 'handleSearch', count: 2 },
      { name: 'handleSubscribe', count: 1 },
    ]);
    // 并列时按名字升序，保证两次运行输出一致。
    expect(summary.parseSources).toEqual([
      { name: 'cache', count: 1 },
      { name: 'llm', count: 1 },
    ]);
  });
});

describe('summarizeMetrics — 工具', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');

  it('按工具计次数、错误率与延迟分位', () => {
    const summary = summarizeMetrics(
      [],
      [
        toolCall({ latencyMs: 10 }),
        toolCall({ latencyMs: 20 }),
        toolCall({ latencyMs: 30, status: 'error' }),
        toolCall({ tool: 'deep_dive_repo', latencyMs: 400 }),
      ],
      { now, days: 1 },
    );

    expect(summary.tools.total).toBe(4);
    expect(summary.tools.errorRate).toBe(0.25);
    const search = summary.tools.byTool.find((row) => row.tool === 'search_trending');
    expect(search).toEqual({
      tool: 'search_trending',
      count: 3,
      errors: 1,
      latencyMs: { p50: 20, p95: 30 },
    });
  });

  it('没有工具调用时 errorRate 为 null', () => {
    const summary = summarizeMetrics([], [], { now, days: 1 });
    expect(summary.tools.total).toBe(0);
    expect(summary.tools.errorRate).toBeNull();
    expect(summary.tools.byTool).toEqual([]);
  });
});
