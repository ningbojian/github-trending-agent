import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 请求级 trace：AsyncLocalStorage 贯穿一次调用，结束时落一行 agent_runs。
 * 正式表写失败时退回 kv_cache（部署前/迁移失败都不影响业务）。
 */
const dbMock = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  kv: [] as Record<string, unknown>[],
  throwRuns: false,
  throwKv: false,
}));

vi.mock('../src/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: () => ({
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          const name = getTableName(table as never);
          if (name === 'agent_runs') {
            if (dbMock.throwRuns) throw new Error('db down');
            dbMock.runs.push(row);
          } else if (name === 'kv_cache') {
            if (dbMock.throwKv) throw new Error('db down');
            dbMock.kv.push(row);
          }
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    }),
  };
});

import {
  currentTraceId,
  note,
  TRACE_MAX_STEPS,
  TRACE_TTL_MS,
  traceError,
  withTrace,
} from '../src/obs/trace';

interface RunRow {
  id: string;
  kind: string;
  userid: string;
  text: string;
  ok: boolean;
  totalMs: number;
  steps: { ms: number; name: string; detail?: string }[];
  createdAt: Date;
}

function lastRun(): RunRow {
  return dbMock.runs[dbMock.runs.length - 1] as unknown as RunRow;
}

beforeEach(() => {
  dbMock.runs = [];
  dbMock.kv = [];
  dbMock.throwRuns = false;
  dbMock.throwKv = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('withTrace — 记录一次调用走过的步骤', () => {
  it('按顺序收集步骤，成功时 ok=true，落一行正式 agent_runs', async () => {
    await withTrace({ kind: 'text', userid: 'zhangsan', text: '本周 rust' }, async () => {
      note('handler', 'handleSearch');
      note('parse', 'cache');
    });

    expect(dbMock.runs).toHaveLength(1);
    expect(dbMock.kv).toHaveLength(0);
    const row = lastRun();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.kind).toBe('text');
    expect(row.userid).toBe('zhangsan');
    expect(row.text).toBe('本周 rust');
    expect(row.ok).toBe(true);
    expect(row.steps.map((s) => s.name)).toEqual(['handler', 'parse']);
    expect(row.steps[1].detail).toBe('cache');
    expect(row.totalMs).toBeGreaterThanOrEqual(0);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('trace 内部能拿到同一个 run id（工具调用用它关联）', async () => {
    let inside: string | null = null;
    await withTrace({ kind: 'text', userid: 'u' }, async () => {
      inside = currentTraceId();
    });
    expect(inside).toBe(lastRun().id);
    expect(currentTraceId()).toBeNull();
  });

  it('同一时刻的两条 trace 互不串味（这是用 AsyncLocalStorage 而不是模块变量的原因）', async () => {
    await Promise.all([
      withTrace({ kind: 'text', userid: 'a', text: '甲' }, async () => {
        note('step', 'a1');
        await new Promise((resolve) => setTimeout(resolve, 5));
        note('step', 'a2');
      }),
      withTrace({ kind: 'text', userid: 'b', text: '乙' }, async () => {
        note('step', 'b1');
        await new Promise((resolve) => setTimeout(resolve, 1));
        note('step', 'b2');
      }),
    ]);

    const byUser = Object.fromEntries(
      dbMock.runs.map((raw) => {
        const row = raw as unknown as RunRow;
        return [row.userid, row.steps.map((s) => s.detail)];
      }),
    );
    expect(byUser.a).toEqual(['a1', 'a2']);
    expect(byUser.b).toEqual(['b1', 'b2']);
  });

  it('没有 trace 时 note() 是静默 no-op（现有单测路径不受影响）', () => {
    expect(() => note('x', 'y')).not.toThrow();
    expect(dbMock.runs).toHaveLength(0);
    expect(dbMock.kv).toHaveLength(0);
  });

  it('fn 抛错时：记录 error 步骤、ok=false、异常照常抛给调用方、记录照样落库', async () => {
    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
        note('handler', 'handleSearch');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const row = lastRun();
    expect(row.ok).toBe(false);
    expect(row.steps.map((s) => s.name)).toEqual(['handler', 'error']);
    expect(row.steps[1].detail).toContain('boom');
  });

  it('traceError 里的 Key 脱敏（trace 会落库，绝不能留明文）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
      traceError(new Error('401 invalid key: sk-abcdef1234567890'));
    });

    expect(JSON.stringify(lastRun())).not.toContain('sk-abcdef1234567890');
    expect(JSON.stringify(lastRun())).toContain('sk-***');
  });

  it('不重复记录同一个异常（dispatchSafely 已记过，withTrace 不再补一条）', async () => {
    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
        const err = new Error('boom');
        traceError(err);
        throw err;
      }),
    ).rejects.toThrow('boom');

    expect(lastRun().steps.filter((s) => s.name === 'error')).toHaveLength(1);
  });

  it('步骤过多时截断，并留下一条 truncated 痕迹（不静默丢数据）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
      for (let i = 0; i < TRACE_MAX_STEPS + 10; i += 1) {
        note(`s${i}`);
      }
    });

    const steps = lastRun().steps;
    expect(steps.length).toBeLessThanOrEqual(TRACE_MAX_STEPS + 1);
    expect(steps[steps.length - 1].name).toBe('truncated');
  });

  it('原话截断到 80 字（trace 不是聊天记录）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x'.repeat(200) }, async () => {});

    expect(Array.from(lastRun().text)).toHaveLength(80);
  });

  it('正式表写入失败 → 退回 kv_cache，业务照常返回', async () => {
    dbMock.throwRuns = true;

    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => 'ok'),
    ).resolves.toBe('ok');

    expect(dbMock.kv).toHaveLength(1);
    const row = dbMock.kv[0] as {
      key: string;
      value: { userid: string; steps: unknown[] };
      expiresAt: Date;
    };
    expect(row.key.startsWith('trace:')).toBe(true);
    const stamp = row.key.slice('trace:'.length, 'trace:'.length + 24);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.value.userid).toBe('u');
    const ttl = row.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(TRACE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(TRACE_TTL_MS);
  });

  it('正式表和 kv 都写失败也不影响调用本身', async () => {
    dbMock.throwRuns = true;
    dbMock.throwKv = true;

    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => 'ok'),
    ).resolves.toBe('ok');
  });
});
