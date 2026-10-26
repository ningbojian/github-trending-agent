import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 请求级 trace：AsyncLocalStorage 贯穿一次调用，结束时一次性落库。
 * db 层用替身；时间用真实 Date。
 */
const dbMock = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  throwOnWrite: false,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    insert: () => ({
      values: (row: unknown) => {
        if (dbMock.throwOnWrite) throw new Error('db down');
        dbMock.inserts.push(row as Record<string, unknown>);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

import {
  note,
  TRACE_MAX_STEPS,
  TRACE_TTL_MS,
  traceError,
  withTrace,
} from '../src/obs/trace';

const DAY_MS = 24 * 60 * 60 * 1000;

function lastRow(): {
  key: string;
  value: {
    kind: string;
    userid: string;
    text: string;
    totalMs: number;
    ok: boolean;
    steps: { ms: number; name: string; detail?: string }[];
  };
  expiresAt: Date;
} {
  return dbMock.inserts[dbMock.inserts.length - 1] as ReturnType<typeof lastRow>;
}

beforeEach(() => {
  dbMock.inserts = [];
  dbMock.throwOnWrite = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('withTrace — 记录一次调用走过的步骤', () => {
  it('按顺序收集步骤，成功时 ok=true，并落一行 7 天过期的记录', async () => {
    await withTrace({ kind: 'text', userid: 'zhangsan', text: '本周 rust' }, async () => {
      note('handler', 'handleSearch');
      note('parse', 'cache');
    });

    expect(dbMock.inserts).toHaveLength(1);
    const row = lastRow();
    expect(row.key.startsWith('trace:')).toBe(true);
    expect(row.value.kind).toBe('text');
    expect(row.value.userid).toBe('zhangsan');
    expect(row.value.text).toBe('本周 rust');
    expect(row.value.ok).toBe(true);
    expect(row.value.steps.map((s) => s.name)).toEqual(['handler', 'parse']);
    expect(row.value.steps[1].detail).toBe('cache');
    expect(row.value.totalMs).toBeGreaterThanOrEqual(0);
    const ttl = row.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(TRACE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(TRACE_TTL_MS);
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
      dbMock.inserts.map((r) => {
        const row = r as unknown as ReturnType<typeof lastRow>;
        return [row.value.userid, row.value.steps.map((s) => s.detail)];
      }),
    );
    expect(byUser.a).toEqual(['a1', 'a2']);
    expect(byUser.b).toEqual(['b1', 'b2']);
  });

  it('没有 trace 时 note() 是静默 no-op（现有单测路径不受影响）', () => {
    expect(() => note('x', 'y')).not.toThrow();
    expect(dbMock.inserts).toHaveLength(0);
  });

  it('fn 抛错时：记录 error 步骤、ok=false、异常照常抛给调用方、记录照样落库', async () => {
    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
        note('handler', 'handleSearch');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const row = lastRow();
    expect(row.value.ok).toBe(false);
    expect(row.value.steps.map((s) => s.name)).toEqual(['handler', 'error']);
    expect(row.value.steps[1].detail).toContain('boom');
  });

  it('traceError 里的 Key 脱敏（trace 会落库，绝不能留明文）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
      traceError(new Error('401 invalid key: sk-abcdef1234567890'));
    });

    expect(JSON.stringify(lastRow())).not.toContain('sk-abcdef1234567890');
    expect(JSON.stringify(lastRow())).toContain('sk-***');
  });

  it('不重复记录同一个异常（dispatchSafely 已记过，withTrace 不再补一条）', async () => {
    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
        const err = new Error('boom');
        traceError(err);
        throw err;
      }),
    ).rejects.toThrow('boom');

    expect(lastRow().value.steps.filter((s) => s.name === 'error')).toHaveLength(1);
  });

  it('步骤过多时截断，并留下一条 truncated 痕迹（不静默丢数据）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {
      for (let i = 0; i < TRACE_MAX_STEPS + 10; i += 1) {
        note(`s${i}`);
      }
    });

    const steps = lastRow().value.steps;
    expect(steps.length).toBeLessThanOrEqual(TRACE_MAX_STEPS + 1);
    expect(steps[steps.length - 1].name).toBe('truncated');
  });

  it('原话截断到 80 字（trace 不是聊天记录）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x'.repeat(200) }, async () => {});

    expect(Array.from(lastRow().value.text)).toHaveLength(80);
  });

  it('写库失败不影响调用本身', async () => {
    dbMock.throwOnWrite = true;

    await expect(
      withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => 'ok'),
    ).resolves.toBe('ok');
  });
});

describe('trace 记录本身', () => {
  it('key 用 ISO 时间开头，字典序倒排即时间倒排（页面按 key desc 取最新）', async () => {
    await withTrace({ kind: 'text', userid: 'u', text: 'x' }, async () => {});

    const key = lastRow().key;
    const stamp = key.slice('trace:'.length, 'trace:'.length + 24);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
