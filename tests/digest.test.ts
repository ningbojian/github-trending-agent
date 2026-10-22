import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import handler, {
  type CronRequest,
  type CronResponse,
  maxDuration,
} from '../api/cron-push-digest';
import { subscribers } from '../src/db/schema';

// ---------------------------------------------------------------------------
// Mocks：LLM / 企微推送 / db 层 / config —— 绝不触网、不连库、不调 LLM。
// ---------------------------------------------------------------------------
const llmMock = vi.hoisted(() => ({
  generateObjectSafe: vi.fn(),
}));

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  executeQueries: [] as unknown[],
  executeRows: [] as Record<string, unknown>[],
  selectConditions: [] as unknown[],
  selectRows: [] as unknown[],
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: llmMock.generateObjectSafe,
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async (query: unknown) => {
      dbMock.executeQueries.push(query);
      return { rows: dbMock.executeRows };
    },
    select: () => ({
      from: () => ({
        where: async (condition: unknown) => {
          dbMock.selectConditions.push(condition);
          return dbMock.selectRows;
        },
      }),
    }),
  }),
}));

vi.mock('../src/config', () => ({
  env: { CRON_SECRET: 'unit-test-cron-secret' },
}));

import { buildDigestForSubscriber, pushDigests } from '../src/agent/digest';

type SubscriberRow = typeof subscribers.$inferSelect;

function makeSub(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: 1,
    wecomUserid: 'alice',
    displayName: 'Alice',
    preferences: { languages: [], keywords: [] },
    githubLogin: null,
    githubTokenEnc: null,
    active: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** 模拟 digest 查询（trending_entries join repos）返回的一行。 */
function makeEntry(
  fullName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    fullName,
    description: `${fullName} 的简介`,
    topics: [],
    stars: 1000,
    starsDelta: 100,
    isNew: false,
    ...overrides,
  };
}

/** 把 drizzle SQL 对象编译为文本 + 参数，便于断言（不触库）。 */
function compileQuery(wrapper: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(wrapper as SQL);
}

/** 取 from/join 之后的 where 片段（无 where 时为空串）。 */
function whereFragment(sqlText: string): string {
  const idx = sqlText.indexOf(' where ');
  return idx === -1 ? '' : sqlText.slice(idx);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.executeQueries.length = 0;
  dbMock.executeRows.length = 0;
  dbMock.selectConditions.length = 0;
  dbMock.selectRows.length = 0;
  // 默认：LLM 不可用（返回 null），发送全部成功。
  llmMock.generateObjectSafe.mockResolvedValue(null);
  apiMock.sendWeComText.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— 偏好过滤
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — 偏好过滤', () => {
  it('preferences.languages 为空 → 不带 language 过滤（全量榜）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).not.toContain(
      '"trending_entries"."language"',
    );
    expect(digest).toContain('a/one');
    expect(digest).toContain('b/two');
  });

  it('preferences 缺失 languages 字段时按全量处理（运行时防御）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: {} as SubscriberRow['preferences'] }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).not.toContain(
      '"trending_entries"."language"',
    );
    expect(digest).toContain('a/one');
  });

  it('preferences.languages 非空 → language IN 参数化过滤', async () => {
    dbMock.executeRows.push(makeEntry('py/match'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: ['python', 'rust'], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).toMatch(
      /"trending_entries"\."language" in \(\$\d+(?:, \$\d+)*\)/,
    );
    expect(compiled.params).toContain('python');
    expect(compiled.params).toContain('rust');
    expect(digest).toContain('py/match');
  });

  it('周期固定为近 7 天（week），候选池 20 条', async () => {
    await buildDigestForSubscriber(makeSub());

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(compiled.params[0]).toBe(7);
    expect(compiled.sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(compiled.params.at(-1)).toBe(20);
  });

  it('最多取 top 10 条进入简报', async () => {
    for (let i = 1; i <= 12; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('10. o/r10');
    expect(digest).not.toContain('o/r11');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— 头部、LLM why、模板降级
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — 简报内容', () => {
  it('头部固定为「📊 今日 GitHub 热榜简报（YYYY-MM-DD）」（UTC 日期）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
    dbMock.executeRows.push(makeEntry('vercel/next.js'));
    try {
      const digest = await buildDigestForSubscriber(makeSub());
      expect(digest.startsWith('📊 今日 GitHub 热榜简报（2026-10-22）\n')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('LLM 成功：每条含一句「为什么上榜」；prompt 区分新上榜与持续霸榜', async () => {
    dbMock.executeRows.push(
      makeEntry('a/fresh', { isNew: true, starsDelta: 500 }),
      makeEntry('b/veteran', { starsDelta: 800 }),
    );
    llmMock.generateObjectSafe.mockResolvedValue({
      reasons: [
        { fullName: 'a/fresh', why: '首次进入热榜的新锐项目' },
        { fullName: 'b/veteran', why: '本周 star 增长 800，持续霸榜' },
      ],
    });

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('   为什么上榜：首次进入热榜的新锐项目');
    expect(digest).toContain('   为什么上榜：本周 star 增长 800，持续霸榜');

    const call = llmMock.generateObjectSafe.mock.calls[0];
    const prompt = String(call?.[1]);
    expect(prompt).toContain('新上榜');
    expect(prompt).toContain('持续霸榜');
    expect(prompt).toContain('a/fresh');
    expect(prompt).toContain('b/veteran');
  });

  it('LLM 返回 null → 模板降级：无「为什么上榜」，仍含完整 repo 列表（★与增量）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(null);
    dbMock.executeRows.push(
      makeEntry('vercel/next.js', { stars: 128000, starsDelta: 321 }),
      makeEntry('rust-lang/rust', { isNew: true, stars: 99000, starsDelta: 100 }),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('1. vercel/next.js ★128000 (+321)');
    expect(digest).toContain('2. rust-lang/rust ★99000 (+100)（新上榜）');
    expect(digest).not.toContain('为什么上榜');
    expect(digest).toContain('📊 今日 GitHub 热榜简报（');
  });

  it('LLM 抛错（违反 never-reject 契约）时仍降级输出 repo 列表', async () => {
    llmMock.generateObjectSafe.mockRejectedValue(new Error('llm exploded'));
    dbMock.executeRows.push(makeEntry('x/y', { stars: 10, starsDelta: 5 }));

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('1. x/y ★10 (+5)');
  });

  it('超长内容截断到 1800 字节内并标注，首条保留', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`owner${i}/repo-with-a-rather-long-name-${i}`, {
        stars: 123456,
        starsDelta: 2345,
      }),
    );
    dbMock.executeRows.push(...entries);
    llmMock.generateObjectSafe.mockResolvedValue({
      reasons: entries.map((e, i) => ({
        fullName: String(e.fullName),
        why: `这是一段很长的上榜理由编号${i}，用来撑爆字节上限。`.repeat(4),
      })),
    });

    const digest = await buildDigestForSubscriber(makeSub());

    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(1800);
    expect(digest).toContain('（内容过长，已截断）');
    expect(digest).toContain('owner0/repo-with-a-rather-long-name-0');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— keywords 轻量生效（提升排序，不丢弃条目）
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — keywords 轻量生效', () => {
  it('命中关键词的条目排到前面，未命中的条目仍保留', async () => {
    dbMock.executeRows.push(
      makeEntry('big/stars', { starsDelta: 900 }),
      makeEntry('ai/agent-kit', { starsDelta: 50, topics: ['ai-agent', 'llm'] }),
    );

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: ['agent'] } }),
    );

    expect(digest.indexOf('ai/agent-kit')).toBeLessThan(
      digest.indexOf('big/stars'),
    );
    expect(digest).toContain('big/stars');
  });

  it('关键词无人命中时保持全量列表（列表绝不因关键词清空）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: [], keywords: ['quantum-blockchain'] },
      }),
    );

    expect(digest).toContain('a/one');
    expect(digest).toContain('b/two');
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 遍历 active 订阅者，单个失败不中断
// ---------------------------------------------------------------------------
describe('pushDigests — 推送计数与容错', () => {
  it('订阅查询按 active = true 过滤', async () => {
    await pushDigests();

    const compiled = compileQuery(dbMock.selectConditions[0]);
    expect(compiled.sql).toMatch(/"subscribers"\."active"\s*=\s*(\$1|true)/);
  });

  it('全部成功 → { sent: n, failed: 0 }，逐个发送对应 userid', async () => {
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    expect(apiMock.sendWeComText.mock.calls.map((c) => c[0])).toEqual([
      'alice',
      'bob',
    ]);
    expect(apiMock.sendWeComText).toHaveBeenLastCalledWith(
      'bob',
      expect.stringContaining('a/one'),
    );
  });

  it('第 2 个订阅者发送抛错时仍处理第 3 个，计数正确', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
      makeSub({ id: 3, wecomUserid: 'carol' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));
    apiMock.sendWeComText
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('wecom down'))
      .mockResolvedValueOnce(undefined);

    const result = await pushDigests();

    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(apiMock.sendWeComText.mock.calls.map((c) => c[0])).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(apiMock.sendWeComText).toHaveBeenLastCalledWith(
      'carol',
      expect.stringContaining('a/one'),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// api/cron-push-digest —— CRON_SECRET 校验
// ---------------------------------------------------------------------------
function mockRes(): CronResponse & {
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
  return res as typeof res & {
    statusCode: number;
    body: string | undefined;
  };
}

function cronReq(auth?: string): CronRequest {
  return {
    method: 'GET',
    headers: auth === undefined ? {} : { authorization: auth },
  };
}

describe('api/cron-push-digest — CRON_SECRET 校验', () => {
  it('无 Authorization 头 → 401 JSON，不做任何推送', async () => {
    const res = mockRes();

    await handler(cronReq(), res);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? '')).toEqual({ error: 'unauthorized' });
    expect(dbMock.selectConditions).toHaveLength(0);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
  });

  it('secret 错误 → 401，不做任何推送', async () => {
    const res = mockRes();

    await handler(cronReq('Bearer wrong-secret'), res);

    expect(res.statusCode).toBe(401);
    expect(dbMock.selectConditions).toHaveLength(0);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('只有裸 secret 而无 Bearer 前缀 → 401', async () => {
    const res = mockRes();

    await handler(cronReq('unit-test-cron-secret'), res);

    expect(res.statusCode).toBe(401);
    expect(dbMock.selectConditions).toHaveLength(0);
  });

  it('Bearer <CRON_SECRET> 正确 → 执行 pushDigests 并返回 {sent, failed} JSON', async () => {
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));
    const res = mockRes();

    await handler(cronReq('Bearer unit-test-cron-secret'), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({ sent: 2, failed: 0 });
    expect(res.headers['content-type']).toContain('application/json');
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Vercel Node 函数配置：maxDuration 经 export 生效（不引入 vercel.json）
// ---------------------------------------------------------------------------
describe('api/cron-push-digest — 函数时长上限', () => {
  it('导出 maxDuration = 300（秒；串行 LLM 简报超过默认上限会尾部丢消息）', () => {
    expect(maxDuration).toBe(300);
  });
});
