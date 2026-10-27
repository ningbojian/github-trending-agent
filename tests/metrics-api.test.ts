import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/metrics：鉴权、取数窗口、JSON 与 HTML 两种输出。
 * 表不存在时给 503 和可执行的提示，而不是假装「今天没有流量」。
 */
const ENV = vi.hoisted(() => ({ CRON_SECRET: 'unit-test-cron-secret' }));

vi.mock('../src/config', () => ({ env: ENV }));

const dbState = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  tools: [] as Record<string, unknown>[],
  failRuns: false,
  failTools: false,
  whereCalls: [] as Array<{ table: string; condition: unknown }>,
}));

vi.mock('../src/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => {
          const name = getTableName(table as never);
          return {
            where: (condition: unknown) => {
              dbState.whereCalls.push({ table: name, condition });
              if (name === 'agent_runs') {
                if (dbState.failRuns) {
                  return Promise.reject(new Error('relation "agent_runs" does not exist'));
                }
                return Promise.resolve([...dbState.runs]);
              }
              if (dbState.failTools) {
                return Promise.reject(new Error('relation "tool_calls" does not exist'));
              }
              return Promise.resolve([...dbState.tools]);
            },
          };
        },
      }),
    }),
  };
});

import handler, { type MetricsRequest, type MetricsResponse } from '../api/metrics';

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdAt: new Date(),
    kind: 'text',
    userid: 'alice',
    ok: true,
    totalMs: 120,
    inputTokens: 10,
    outputTokens: 4,
    steps: [{ ms: 0, name: 'handler', detail: 'handleSearch' }],
    ...overrides,
  };
}

function toolRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdAt: new Date(),
    tool: 'search_trending',
    status: 'ok',
    latencyMs: 80,
    ...overrides,
  };
}

function mockRes(): MetricsResponse & {
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
  overrides: Partial<MetricsRequest> = {},
): MetricsRequest {
  return { method: 'GET', query, headers: {}, ...overrides };
}

beforeEach(() => {
  dbState.runs.length = 0;
  dbState.tools.length = 0;
  dbState.failRuns = false;
  dbState.failTools = false;
  dbState.whereCalls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('api/metrics 鉴权', () => {
  it('缺 secret → 401，不查库', async () => {
    const res = mockRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(401);
    expect(dbState.whereCalls).toHaveLength(0);
  });

  it('secret 错误 → 401', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: 'nope' }), res);

    expect(res.statusCode).toBe(401);
  });

  it('Bearer 也可通过；非 GET → 405', async () => {
    const res = mockRes();
    await handler(
      makeReq({}, { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }),
      res,
    );
    expect(res.statusCode).toBe(200);

    const post = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET }, { method: 'POST' }), post);
    expect(post.statusCode).toBe(405);
  });
});

describe('api/metrics 取数', () => {
  it('默认 7 天，查询两张表并带上 since 条件', async () => {
    const res = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(200);
    expect(dbState.whereCalls.map((call) => call.table).sort()).toEqual([
      'agent_runs',
      'tool_calls',
    ]);
    const { PgDialect } = await import('drizzle-orm/pg-core');
    for (const call of dbState.whereCalls) {
      const compiled = new PgDialect().sqlToQuery(call.condition as never);
      expect(compiled.sql).toContain('created_at');
      // 方言层把 Date 编译成 ISO 字符串参数；解析回来必须是一个过去的合法时间。
      const since = new Date(String(compiled.params[0]));
      expect(Number.isNaN(since.getTime())).toBe(false);
      expect(since.getTime()).toBeLessThan(Date.now());
    }
  });

  it('JSON：真实汇总 + userid 只以哈希出现', async () => {
    dbState.runs.push(runRow(), runRow({ ok: false, userid: 'bob' }));
    dbState.tools.push(toolRow(), toolRow({ status: 'error' }));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.headers['content-type']).toContain('application/json');
    const body = res.body ?? '';
    expect(body).not.toContain('alice');
    expect(body).not.toContain('bob');
    const payload = JSON.parse(body) as {
      windowDays: number;
      runs: { total: number; okRate: number; distinctUsers: number };
      routes: Array<{ name: string; count: number }>;
      tools: { total: number; errorRate: number };
    };
    expect(payload.windowDays).toBe(7);
    expect(payload.runs).toMatchObject({ total: 2, okRate: 0.5, distinctUsers: 2 });
    expect(payload.routes).toEqual([{ name: 'handleSearch', count: 2 }]);
    expect(payload.tools).toMatchObject({ total: 2, errorRate: 0.5 });
  });

  it('?days=14 反映到窗口，且超上限夹到 30', async () => {
    const first = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET, days: '14' }), first);
    expect(JSON.parse(first.body ?? '{}').windowDays).toBe(14);

    const second = mockRes();
    await handler(makeReq({ secret: ENV.CRON_SECRET, days: '999' }), second);
    expect(JSON.parse(second.body ?? '{}').windowDays).toBe(30);
  });

  it('?format=html 渲染页面，并且照样转义/不含原始 userid', async () => {
    dbState.runs.push(runRow({ userid: '<script>alert(1)</script>' }));
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET, format: 'html' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body ?? '').toContain('度量');
    expect(res.body ?? '').not.toContain('<script>alert(1)</script>');
    expect(res.body ?? '').toContain('handleSearch');
  });
});

describe('api/metrics 迁移缺失', () => {
  it('agent_runs 不存在 → 503，提示先迁移（不输出全 0）', async () => {
    dbState.failRuns = true;
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(503);
    const payload = JSON.parse(res.body ?? '{}') as { error: string; hint: string };
    expect(payload.error).toBe('metrics-unavailable');
    expect(payload.hint).toContain('db:migrate');
  });

  it('tool_calls 不存在 → 同样 503（不能报半份假数据）', async () => {
    dbState.failTools = true;
    const res = mockRes();

    await handler(makeReq({ secret: ENV.CRON_SECRET }), res);

    expect(res.statusCode).toBe(503);
  });
});
