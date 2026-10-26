import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/trace 只读页：鉴权 + 取数 + 服务端渲染。
 * db 用链式桩（select → from → where → orderBy → limit），不触库。
 */
const ENV = vi.hoisted(() => ({ CRON_SECRET: 'unit-test-cron-secret' }));

vi.mock('../src/config', () => ({ env: ENV }));

const dbState = vi.hoisted(() => ({
  rows: [] as Array<{ key: string; value: unknown }>,
  whereCalls: [] as unknown[],
  limitCalls: [] as number[],
  selectCalls: 0,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => {
      dbState.selectCalls += 1;
      return {
        from: () => ({
          where: (condition: unknown) => {
            dbState.whereCalls.push(condition);
            return {
              orderBy: () => ({
                limit: (count: number) => {
                  dbState.limitCalls.push(count);
                  return Promise.resolve([...dbState.rows]);
                },
              }),
            };
          },
        }),
      };
    },
  }),
}));

import handler, { type TraceRequest, type TraceResponse } from '../api/trace';

/** 一条正常 trace 的 value 形状（与 src/obs/trace.ts 的 flushTrace 一致）。 */
function traceValue(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: 'text',
    userid: 'alice',
    text: '今天股市怎么样',
    totalMs: 1234,
    ok: true,
    steps: [
      { ms: 0, name: 'handler', detail: 'handleSearch' },
      { ms: 900, name: 'parse-source', detail: 'llm' },
      { ms: 300, name: 'send', detail: 'ok 412 字节' },
    ],
    ...overrides,
  };
}

/** key 以 ISO 时间开头（与 trace.ts 一致）。 */
function traceKey(iso: string, suffix = 'abcdef12'): string {
  return `trace:${iso}-${suffix}`;
}

function mockRes(): TraceResponse & {
  statusCode: number;
  body: string | undefined;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 0,
    body: undefined as string | undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeReq(
  query: Record<string, string | string[] | undefined> = {},
  overrides: Partial<TraceRequest> = {},
): TraceRequest {
  return { method: 'GET', query, headers: {}, ...overrides };
}

/** 把 drizzle SQL 条件编译为文本 + 参数（不触库）。 */
function compileWhere(index = 0): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(dbState.whereCalls[index] as SQL);
}

beforeEach(() => {
  dbState.rows.length = 0;
  dbState.whereCalls.length = 0;
  dbState.limitCalls.length = 0;
  dbState.selectCalls = 0;
});

describe('api/trace 鉴权', () => {
  it('缺 secret → 401，且不查库', async () => {
    const res = mockRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(401);
    expect(dbState.selectCalls).toBe(0);
  });

  it('secret 错误 → 401，且不查库', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: 'wrong-secret' }), res);

    expect(res.statusCode).toBe(401);
    expect(dbState.selectCalls).toBe(0);
  });

  it('Authorization: Bearer 也可通过', async () => {
    dbState.rows.push({ key: traceKey('2026-10-26T01:00:00.000Z'), value: traceValue() });
    const res = mockRes();

    await handler(
      makeReq({}, { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(dbState.selectCalls).toBe(1);
  });

  it('非 GET → 405，且不查库', async () => {
    const res = mockRes();

    await handler(
      makeReq({ secret: ENV.CRON_SECRET }, { method: 'POST' }),
      res,
    );

    expect(res.statusCode).toBe(405);
    expect(dbState.selectCalls).toBe(0);
  });
});

describe('api/trace 渲染', () => {
  it('正常：HTML 里能看到用户、原话、总耗时与每一步', async () => {
    dbState.rows.push({
      key: traceKey('2026-10-26T01:02:03.456Z'),
      value: traceValue(),
    });
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const body = res.body ?? '';
    expect(body).toContain('alice');
    expect(body).toContain('今天股市怎么样');
    expect(body).toContain('1234');
    expect(body).toContain('handleSearch');
    expect(body).toContain('parse-source');
    // 北京时间显示（01:02:03Z → 09:02:03）
    expect(body).toContain('09:02:03');
  });

  it('失败的一步：ok=false 时摘要行给出 ✗ 标记', async () => {
    dbState.rows.push({
      key: traceKey('2026-10-26T01:00:00.000Z'),
      value: traceValue({ ok: false }),
    });
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.body ?? '').toContain('✗');
  });

  it('原话里的 HTML 被转义（不注入页面）', async () => {
    dbState.rows.push({
      key: traceKey('2026-10-26T01:00:00.000Z'),
      value: traceValue({ text: '<script>alert(1)</script>' }),
    });
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    const body = res.body ?? '';
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('value 畸形（缺字段/非对象）不崩，页面给出占位', async () => {
    dbState.rows.push(
      { key: traceKey('2026-10-26T01:00:00.000Z'), value: null },
      { key: traceKey('2026-10-26T00:59:00.000Z'), value: { steps: 'oops' } },
    );
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body ?? '').toContain('运行日志');
  });

  it('没有任何 trace → 空态文案', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body ?? '').toContain('暂无');
  });
});

describe('api/trace 参数', () => {
  it('n 默认 50', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);
    expect(dbState.limitCalls).toEqual([50]);
  });

  it('n 超上限被夹到 200', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: '9999' }), res);
    expect(dbState.limitCalls).toEqual([200]);
  });

  it('n 非法（非数字/0/负数）回落到默认 50', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: 'abc' }), res);
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: '0' }), res);
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: '-3' }), res);
    expect(dbState.limitCalls).toEqual([50, 50, 50]);
  });

  it('u 过滤：SQL 里按 value->>userid 过滤并带上参数', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET, u: 'alice' }), res);

    const compiled = compileWhere();
    expect(compiled.sql).toContain(`->>`);
    expect(compiled.sql).toContain('userid');
    expect(compiled.params).toContain('alice');
  });

  it('不带 u 时 WHERE 只按前缀过滤（不含 userid 条件）', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    const compiled = compileWhere();
    expect(compiled.sql).not.toContain('userid');
    expect(compiled.params).toContain('trace:%');
  });
});
