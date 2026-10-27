import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 工具调用流水：只记工具名、参数哈希、状态与耗时。
 * 参数里可能有用户原话，所以绝不落原文；写库失败也不能影响工具本身。
 */

const dbMock = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  fail: false,
}));

vi.mock('../src/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: () => ({
      insert: (table: unknown) => ({
        values: async (row: Record<string, unknown>) => {
          if (getTableName(table as never) !== 'tool_calls') return;
          if (dbMock.fail) throw new Error('db down');
          dbMock.rows.push(row);
        },
      }),
    }),
  };
});

const traceMock = vi.hoisted(() => ({ runId: null as string | null }));

vi.mock('../src/obs/trace', () => ({
  currentTraceId: () => traceMock.runId,
}));

import { hashArgs, recordToolCall } from '../src/obs/tool-calls';
import { instrumentTools } from '../src/agent/tool-loop';

beforeEach(() => {
  dbMock.rows = [];
  dbMock.fail = false;
  traceMock.runId = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordToolCall', () => {
  it('不在 trace 内 → 不写库（cron/单测里没有 run 可关联）', async () => {
    const written = await recordToolCall({
      tool: 'search_trending',
      args: {},
      status: 'ok',
      latencyMs: 12,
    });
    expect(written).toBe(false);
    expect(dbMock.rows).toHaveLength(0);
  });

  it('有 run id → 写一行，参数只留哈希', async () => {
    traceMock.runId = 'run-1';
    const written = await recordToolCall({
      tool: 'deep_dive_repo',
      args: { repo: 'facebook/react' },
      status: 'ok',
      latencyMs: 321.4,
    });
    expect(written).toBe(true);
    expect(dbMock.rows[0]).toMatchObject({
      runId: 'run-1',
      tool: 'deep_dive_repo',
      status: 'ok',
      latencyMs: 321,
    });
    expect(dbMock.rows[0]?.argsHash).toBe(hashArgs({ repo: 'facebook/react' }));
    expect(JSON.stringify(dbMock.rows[0])).not.toContain('facebook/react');
  });

  it('写库失败 → 返回 false，不抛', async () => {
    traceMock.runId = 'run-1';
    dbMock.fail = true;
    await expect(
      recordToolCall({ tool: 'x', args: null, status: 'error', latencyMs: 1 }),
    ).resolves.toBe(false);
  });
});

describe('hashArgs', () => {
  it('同参数同哈希、不同参数不同哈希；不可序列化也返回稳定串', () => {
    expect(hashArgs({ a: 1 })).toBe(hashArgs({ a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(hashArgs(circular)).toBe('unhashable');
  });
});

describe('instrumentTools', () => {
  const record = vi.fn(async () => undefined);

  beforeEach(() => {
    record.mockClear();
  });

  it('保留工具定义，执行成功时记 ok 并返回原结果', async () => {
    const execute = vi.fn(async (args: { q: string }) => `found ${args.q}`);
    const wrapped = instrumentTools(
      { search: { description: 'd', execute } },
      record,
    ) as Record<string, { description?: string; execute: (args: { q: string }) => Promise<string> }>;

    await expect(wrapped.search.execute({ q: 'rust' })).resolves.toBe('found rust');
    expect(wrapped.search.description).toBe('d');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'search', status: 'ok' }),
    );
  });

  it('执行失败时记 error 并照常抛出（工具错误仍交给模型/调用方处理）', async () => {
    const execute = vi.fn(async () => {
      throw new Error('403');
    });
    const wrapped = instrumentTools({ health: { execute } }, record) as Record<
      string,
      { execute: () => Promise<unknown> }
    >;

    await expect(wrapped.health.execute()).rejects.toThrow('403');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'health', status: 'error' }),
    );
  });

  it('没有 execute 的对象原样保留', () => {
    const schemaOnly = { description: 'no executor' };
    const wrapped = instrumentTools({ schemaOnly }, record);
    expect(wrapped.schemaOnly).toBe(schemaOnly);
  });
});
