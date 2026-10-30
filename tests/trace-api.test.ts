import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/trace 只读页：鉴权 + 取数 + 服务端渲染。
 *
 * 主数据源是 agent_runs；kv_cache 里的 trace 是迁移前/写入失败时的降级记录，
 * 两边合并展示，7 天后 kv 自然过期。
 */
const ENV = vi.hoisted(() => ({ CRON_SECRET: 'unit-test-cron-secret' }));

vi.mock('../src/config', () => ({ env: ENV }));

const dbState = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  kv: [] as Array<{ key: string; value: unknown }>,
  failRuns: false,
  failKv: false,
  whereCalls: [] as Array<{ table: string; condition: unknown }>,
  limitCalls: [] as number[],
  selectCalls: 0,
}));

vi.mock('../src/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: () => ({
      select: () => {
        dbState.selectCalls += 1;
        return {
          from: (table: unknown) => {
            const name = getTableName(table as never);
            return {
              where: (condition: unknown) => {
                dbState.whereCalls.push({ table: name, condition });
                return {
                  orderBy: () => ({
                    limit: (count: number) => {
                      dbState.limitCalls.push(count);
                      if (name === 'agent_runs') {
                        if (dbState.failRuns) {
                          throw new Error('relation "agent_runs" does not exist');
                        }
                        return Promise.resolve([...dbState.runs]);
                      }
                      if (dbState.failKv) {
                        throw new Error('kv down');
                      }
                      return Promise.resolve([...dbState.kv]);
                    },
                  }),
                };
              },
            };
          },
        };
      },
    }),
  };
});

import handler, { type TraceRequest, type TraceResponse } from '../api/trace';

const STEPS = [
  { ms: 0, name: 'handler', detail: 'handleSearch' },
  { ms: 900, name: 'parse-source', detail: 'llm' },
  { ms: 300, name: 'send', detail: 'ok 412 字节' },
];

/** 一条正常 agent_runs 行（与 src/obs/trace.ts 的 flushTrace 一致）。 */
function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    kind: 'text',
    userid: 'alice',
    text: '今天股市怎么样',
    totalMs: 1234,
    ok: true,
    steps: STEPS,
    createdAt: new Date('2026-10-26T01:02:03.456Z'),
    ...overrides,
  };
}

/** 一条降级 kv 记录（key 以 ISO 时间开头，与 trace.ts 一致）。 */
function kvRow(iso: string, overrides: Record<string, unknown> = {}) {
  return {
    key: `trace:${iso}-abcdef12`,
    value: {
      kind: 'text',
      userid: 'bob',
      text: 'kv 里的旧记录',
      totalMs: 777,
      ok: true,
      steps: [{ ms: 0, name: 'handler', detail: 'handleHelp' }],
      ...overrides,
    },
  };
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
  return new PgDialect().sqlToQuery(dbState.whereCalls[index]?.condition as SQL);
}

beforeEach(() => {
  dbState.runs.length = 0;
  dbState.kv.length = 0;
  dbState.failRuns = false;
  dbState.failKv = false;
  dbState.whereCalls.length = 0;
  dbState.limitCalls.length = 0;
  dbState.selectCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
    dbState.runs.push(runRow());
    const res = mockRes();

    await handler(
      makeReq({}, { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    // 两个数据源各查一次：agent_runs + kv 降级记录。
    expect(dbState.selectCalls).toBe(2);
  });

  it('非 GET → 405，且不查库', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }, { method: 'POST' }), res);

    expect(res.statusCode).toBe(405);
    expect(dbState.selectCalls).toBe(0);
  });
});

describe('api/trace 渲染', () => {
  it('agent_runs：能看到用户、原话、总耗时、每一步与北京时间', async () => {
    dbState.runs.push(runRow());
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
    // createdAt = 01:02:03Z → 北京时间 09:02:03
    expect(body).toContain('09:02:03');
    expect(body).toContain('p-disclosure');
    expect(body).toContain('p-table-wrap');
  });

  it('失败的一步：ok=false 时摘要行给出 ✗ 标记', async () => {
    dbState.runs.push(runRow({ ok: false }));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.body ?? '').toContain('✗');
  });

  it('原话里的 HTML 被转义（不注入页面）', async () => {
    dbState.runs.push(runRow({ text: '<script>alert(1)</script>' }));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    const body = res.body ?? '';
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('steps 畸形（非数组/非对象）不崩，页面给出占位', async () => {
    dbState.runs.push(runRow({ steps: 'oops', userid: null }));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body ?? '').toContain('运行日志');
    expect(res.body ?? '').toContain('形状不对');
  });

  it('迁移前的 kv 记录仍然显示（与 agent_runs 合并）', async () => {
    dbState.runs.push(runRow());
    dbState.kv.push(kvRow('2026-10-26T01:00:00.000Z'));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    const body = res.body ?? '';
    expect(body).toContain('alice');
    expect(body).toContain('bob');
    expect(body).toContain('kv 里的旧记录');
  });

  it('agent_runs 不存在（迁移未执行）→ 回落 kv，页面照常 200', async () => {
    dbState.failRuns = true;
    dbState.kv.push(kvRow('2026-10-26T01:00:00.000Z'));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body ?? '').toContain('kv 里的旧记录');
  });

  it('两个数据源都失败 → 500（不假装「没有记录」）', async () => {
    dbState.failRuns = true;
    dbState.failKv = true;
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body ?? '').toContain('读取失败');
  });

  it('没有任何记录 → 空态文案', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body ?? '').toContain('暂无');
  });
});

describe('api/trace 参数', () => {
  it('n 默认 50（两个数据源各取 50）', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);
    expect(dbState.limitCalls).toEqual([50, 50]);
  });

  it('n 超上限被夹到 200', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: '9999' }), res);
    expect(dbState.limitCalls).toEqual([200, 200]);
  });

  it('n 非法（非数字/0/负数）回落到默认 50', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: 'abc' }), res);
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: '0' }), res);
    await handler(makeReq({ secret: ENV.CRON_SECRET, n: '-3' }), res);
    expect(dbState.limitCalls).toEqual([50, 50, 50, 50, 50, 50]);
  });

  it('u 过滤：agent_runs 按 userid 列过滤', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET, u: 'alice' }), res);

    const runWhere = dbState.whereCalls.find((call) => call.table === 'agent_runs');
    expect(runWhere).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(runWhere?.condition as SQL);
    expect(compiled.sql).toContain('userid');
    expect(compiled.params).toContain('alice');
  });

  it('u 过滤：kv 仍按 value->>userid 过滤', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET, u: 'alice' }), res);

    const kvWhere = dbState.whereCalls.find((call) => call.table === 'kv_cache');
    expect(kvWhere).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(kvWhere?.condition as SQL);
    expect(compiled.sql).toContain('->>');
    expect(compiled.sql).toContain('userid');
    expect(compiled.params).toContain('alice');
  });

  it('不带 u：agent_runs 条件为 true，kv 只按前缀过滤', async () => {
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    const runWhere = dbState.whereCalls.find((call) => call.table === 'agent_runs');
    const kvWhere = dbState.whereCalls.find((call) => call.table === 'kv_cache');
    const runSql = new PgDialect().sqlToQuery(runWhere?.condition as SQL);
    const kvSql = new PgDialect().sqlToQuery(kvWhere?.condition as SQL);
    expect(runSql.sql.trim()).toBe('true');
    expect(kvSql.params).toContain('trace:%');
    expect(kvSql.sql).not.toContain('userid');
  });
});
