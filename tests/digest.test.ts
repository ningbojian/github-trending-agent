import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, {
  type CronRequest,
  type CronResponse,
  maxDuration,
} from '../api/cron-push-digest';
import { searchCaches, subscribers } from '../src/db/schema';

// ---------------------------------------------------------------------------
// Mocks：企微推送（文本）/ 仓库简介（loadRepoSummaries）/ db 层 / config —— 绝不触网、不连库、不调 LLM。
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  sendWeComNews: vi.fn(),
}));

const summaryMock = vi.hoisted(() => ({
  loadRepoSummaries: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  executeQueries: [] as unknown[],
  executeRows: [] as Record<string, unknown>[],
  executeError: undefined as Error | undefined,
  selectConditions: [] as unknown[],
  selectRows: [] as unknown[],
  deleteCalls: [] as { table: unknown; condition: unknown }[],
  insertCalls: [] as { table: unknown; values: Record<string, unknown> }[],
  insertError: undefined as Error | undefined,
  deleteError: undefined as Error | undefined,
  /**
   * update 流水线记录：kind='claim' 为条件 UPDATE … RETURNING（抢占），
   * kind='update' 为普通 update（回滚 last_digest_at 等）。
   */
  updateCalls: [] as {
    table: unknown;
    values: Record<string, unknown>;
    condition: unknown;
    kind: 'claim' | 'update';
  }[],
  /** 抢占 RETURNING 结果队列：逐次 shift；耗尽后默认返回一行（抢占成功）。 */
  claimResults: [] as Record<string, unknown>[][],
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
  sendWeComNews: apiMock.sendWeComNews,
}));

/**
 * trace 会给每条消息往 kv_cache 多写一行 insert：本文件大量断言 insert 次数，
 * 让它只透传执行、不落库。trace 本身由 tests/trace.test.ts 覆盖。
 */
vi.mock('../src/obs/trace', () => ({
  withTrace: (_meta: unknown, fn: () => Promise<unknown>) => fn(),
  note: () => {},
  traceError: () => {},
}));

/**
 * Abstract 单独打桩：回退构建会给简报加一段开头概览，
 * 但这层不该在 digest 的测试里真去碰模型（配置缺失会走 recordLlmFailure 写库，
 * 污染本文件对 insert/delete 次数的断言）。
 */
const abstractMock = vi.hoisted(() => ({
  loadAbstractSafe: vi.fn(async () => null as string | null),
}));

vi.mock('../src/agent/abstract', () => ({
  loadAbstractSafe: abstractMock.loadAbstractSafe,
}));

vi.mock('../src/agent/repo-summary', () => ({
  loadRepoSummaries: summaryMock.loadRepoSummaries,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async (query: unknown) => {
      if (dbMock.executeError) {
        throw dbMock.executeError;
      }
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
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const record = { table, values, condition };
          let recordedPlain = false;
          return {
            /** 条件抢占路径：await …returning()。 */
            returning: async () => {
              dbMock.updateCalls.push({ ...record, kind: 'claim' });
              return dbMock.claimResults.length > 0
                ? (dbMock.claimResults.shift() as Record<string, unknown>[])
                : [{ id: 1 }];
            },
            /** 普通 update 路径：直接 await where(...)（drizzle thenable 语义）。 */
            then: (
              onFulfilled?: (value: void) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) => {
              if (!recordedPlain) {
                recordedPlain = true;
                dbMock.updateCalls.push({ ...record, kind: 'update' });
              }
              return Promise.resolve(undefined).then(onFulfilled, onRejected);
            },
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        dbMock.deleteCalls.push({ table, condition });
        if (dbMock.deleteError) {
          throw dbMock.deleteError;
        }
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        dbMock.insertCalls.push({ table, values });
        if (dbMock.insertError) {
          throw dbMock.insertError;
        }
      },
    }),
  }),
}));

vi.mock('../src/config', () => ({
  env: { CRON_SECRET: 'unit-test-cron-secret' },
}));

/**
 * cron 现在还会：构建/读取当日快照、推送邮件、刷新企微成员数缓存。
 * - 快照默认 null → pushDigests 走既有 buildDigestWithEntries 路径（本文件断言不变）。
 * - 选择层保留真实实现（纯函数），避免「测 mock」。
 */
const snapshotMock = vi.hoisted(() => ({
  getDailySnapshot: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../src/agent/digest-snapshot', async () => {
  const actual = await vi.importActual<
    typeof import('../src/agent/digest-snapshot')
  >('../src/agent/digest-snapshot');
  return { ...actual, getDailySnapshot: snapshotMock.getDailySnapshot };
});

const emailPushMock = vi.hoisted(() => ({
  pushEmailDigests: vi.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

vi.mock('../src/email/push', () => ({
  pushEmailDigests: emailPushMock.pushEmailDigests,
}));

const capacityMock = vi.hoisted(() => ({
  refreshWeComMemberCount: vi.fn(async () => null),
}));

vi.mock('../src/wecom/capacity', () => ({
  refreshWeComMemberCount: capacityMock.refreshWeComMemberCount,
}));

// 每周复盘在独立文件里测编排；这里只证明端点把它接上了、响应形状稳定。
const weeklyMock = vi.hoisted(() => ({
  pushWeeklyReviews: vi.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

vi.mock('../src/agent/weekly-review', () => ({
  pushWeeklyReviews: weeklyMock.pushWeeklyReviews,
}));

/**
 * 口味画像与推送历史：默认「空画像 / 无历史」，既有用例行为不变。
 * 只替换 I/O 两个函数，纯函数（rankByTaste / pushedRecently / emptySignals）保持真实实现。
 */
const tasteMock = vi.hoisted(() => ({
  loadUserSignals: vi.fn(),
  loadUserSignalsStrict: vi.fn(),
}));

vi.mock('../src/agent/taste', async () => {
  const actual = await vi.importActual<typeof import('../src/agent/taste')>(
    '../src/agent/taste',
  );
  return {
    ...actual,
    loadUserSignals: tasteMock.loadUserSignals,
    loadUserSignalsStrict: tasteMock.loadUserSignalsStrict,
  };
});

/** 网页端 star 名单：默认「未绑定 → null」，需要时逐用例给值。 */
const starMock = vi.hoisted(() => ({ loadStarredNames: vi.fn() }));

vi.mock('../src/github/starred-names', () => ({
  loadStarredNames: starMock.loadStarredNames,
}));

const historyMock = vi.hoisted(() => ({
  readPushHistory: vi.fn(),
  recordPush: vi.fn(),
}));

vi.mock('../src/agent/push-history', async () => {
  const actual = await vi.importActual<typeof import('../src/agent/push-history')>(
    '../src/agent/push-history',
  );
  return {
    ...actual,
    readPushHistory: historyMock.readPushHistory,
    recordPush: historyMock.recordPush,
  };
});

import {
  buildDigestForSubscriber,
  buildDigestFromSnapshot,
  buildDigestNewsFromSnapshot,
  buildDigestWithEntries,
  DIGEST_FOOTER,
  invalidateRecentResults,
  markDigestSent,
  pushDigests,
  QUIET_NOTE_AFTER_DAYS,
  quietNote,
  saveRecentResults,
  shanghaiHHMM,
  shanghaiMinutes,
  shanghaiToday,
} from '../src/agent/digest';
import {
  composeSignals,
  emptySignals,
  type UserSignals,
} from '../src/agent/taste';

type SubscriberRow = typeof subscribers.$inferSelect;

function makeSub(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: 1,
    wecomUserid: 'alice',
    displayName: 'Alice',
    // pushTime '00:00' → 时间门恒过：本文件既有用例聚焦缓存写/计数语义，
    // 不因运行时刻而变；门控语义由下方「推送时间/间隔门控」describe 显式覆盖。
    preferences: { languages: [], keywords: [], pushTime: '00:00' },
    githubLogin: null,
    githubTokenEnc: null,
    llmBaseUrl: null,
    llmModel: null,
    llmKeyEnc: null,
    active: true,
    lastDigestAt: null,
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
    htmlUrl: `https://github.com/${fullName}`,
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
  dbMock.executeError = undefined;
  dbMock.selectConditions.length = 0;
  dbMock.selectRows.length = 0;
  dbMock.deleteCalls.length = 0;
  dbMock.insertCalls.length = 0;
  dbMock.insertError = undefined;
  dbMock.deleteError = undefined;
  dbMock.updateCalls.length = 0;
  dbMock.claimResults.length = 0;
  // 默认：简介降级（空 Map，等价 LLM 失败后的无简介输出），发送全部成功。
  summaryMock.loadRepoSummaries.mockResolvedValue(new Map());
  abstractMock.loadAbstractSafe.mockResolvedValue(null);
  apiMock.sendWeComText.mockResolvedValue(undefined);
  // 默认空画像 + 无历史：既有用例只看「不过滤」的行为。
  tasteMock.loadUserSignals.mockResolvedValue(emptySignals());
  tasteMock.loadUserSignalsStrict.mockResolvedValue(emptySignals());
  starMock.loadStarredNames.mockResolvedValue(null);
  historyMock.readPushHistory.mockResolvedValue(null);
  historyMock.recordPush.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// shanghaiToday —— 北京时间日期（Vercel 运行时为 UTC，直接 toISOString 会错一天）
// ---------------------------------------------------------------------------
describe('shanghaiToday — 北京时间日期', () => {
  it('UTC 16:00（北京次日 00:00）→ 返回北京日期 YYYY-MM-DD', () => {
    expect(shanghaiToday(new Date('2026-10-22T16:00:00Z'))).toBe('2026-10-23');
  });

  it('UTC 15:59:59（北京当日 23:59:59）→ 仍是当日', () => {
    expect(shanghaiToday(new Date('2026-10-22T15:59:59Z'))).toBe('2026-10-22');
  });

  it('格式恒为 en-CA 风格 YYYY-MM-DD', () => {
    expect(shanghaiToday(new Date('2026-01-01T20:00:00Z'))).toBe('2026-01-02');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— 偏好过滤
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — 偏好过滤', () => {
  it('preferences.languages 为空 → 不带语言过滤（全量榜）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).not.toContain('"repos"."language"');
    expect(digest).toContain('a/one');
    expect(digest).toContain('b/two');
  });

  it('preferences 缺失 languages 字段时按全量处理（运行时防御）', async () => {
    dbMock.executeRows.push(makeEntry('a/one'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: {} as SubscriberRow['preferences'] }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).not.toContain('"repos"."language"');
    expect(digest).toContain('a/one');
  });

  it('preferences.languages 非空 → lower(repos.language) IN 参数化过滤', async () => {
    dbMock.executeRows.push(makeEntry('py/match'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: ['python', 'rust'], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).toMatch(
      /lower\("repos"\."language"\) in \(\$\d+(?:, \$\d+)*\)/,
    );
    expect(compiled.params).toContain('python');
    expect(compiled.params).toContain('rust');
    expect(digest).toContain('py/match');
  });

  it('preferences.languages=["Java"] 经 lowercase 命中仓库真实语言（lower(repos.language) 匹配 "Java"）', async () => {
    dbMock.executeRows.push(makeEntry('jdk/tool'));

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: ['Java'], keywords: [] } }),
    );

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(whereFragment(compiled.sql)).toMatch(
      /lower\("repos"\."language"\) in \(\$\d+\)/,
    );
    // normalizePreferences 已 lowercase，参数不再二次 lower
    expect(compiled.params).toContain('java');
    expect(digest).toContain('jdk/tool');
  });

  it('周期固定为近 7 天（week），候选池 20 条', async () => {
    await buildDigestForSubscriber(makeSub());

    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(compiled.params[0]).toBe(7);
    expect(compiled.sql.trimEnd()).toMatch(/limit \$\d+$/);
    expect(compiled.params.at(-1)).toBe(20);
  });

  it('未设置条数时默认取 top 8（企微 news 上限）', async () => {
    for (let i = 1; i <= 10; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('8. o/r8');
    expect(digest).not.toContain('o/r9');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber — digestCount 用户自定义条数（clamp 1–8，默认 8）
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — digestCount 用户自定义', () => {
  it('preferences.digestCount=3 → 简报恰 3 条', async () => {
    for (let i = 1; i <= 5; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 3 } }),
    );

    expect(digest).toContain('3. o/r3');
    expect(digest).not.toContain('o/r4');
  });

  it('digestCount=0 → clamp 到下限 1', async () => {
    for (let i = 1; i <= 3; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 0 } }),
    );

    expect(digest).toContain('1. o/r1');
    expect(digest).not.toContain('o/r2');
  });

  it('digestCount=99 → clamp 到上限 8（news 一条最多 8 篇）', async () => {
    for (let i = 1; i <= 10; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 99 },
      }),
    );

    expect(digest).toContain('8. o/r8');
    expect(digest).not.toContain('o/r9');
  });

  it('digestCount 为字符串等非法类型 → 回退默认 8', async () => {
    for (let i = 1; i <= 10; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: {
          languages: [],
          keywords: [],
          digestCount: '5' as unknown as number,
        },
      }),
    );

    expect(digest).toContain('8. o/r8');
    expect(digest).not.toContain('o/r9');
  });
});

// ---------------------------------------------------------------------------
// buildDigestForSubscriber —— 头部日期（北京时间）、单行格式、简介注入与降级
// ---------------------------------------------------------------------------
describe('buildDigestForSubscriber — 简报内容', () => {
  it('头部日期为北京时间：UTC 16:30 推送时日期已是北京次日', async () => {
    dbMock.executeRows.push(makeEntry('vercel/next.js'));

    const digest = await buildDigestForSubscriber(
      makeSub(),
      new Date('2026-10-22T16:30:00Z'),
    );

    expect(digest.startsWith('📊 今日 GitHub 热榜简报（2026-10-23）\n')).toBe(true);
  });

  it('空榜锁定：只有头部 + 占位文案，且不带收藏页脚（无可收藏条目）', async () => {
    // characterization 测试：锁定 assemble 的 EMPTY_NOTICE 分支——
    // 空榜时故意省略 DIGEST_FOOTER（「收藏 N」在无可收藏条目时是误导）。
    // Task 4 决策：空榜 entries=[] → 不写 search_caches（保留上一次有效缓存）。
    const digest = await buildDigestForSubscriber(
      makeSub(),
      new Date('2026-10-22T16:30:00Z'),
    );

    expect(digest).toBe(
      '📊 今日 GitHub 热榜简报（2026-10-23）\n\n今日暂无符合条件的热榜项目。',
    );
    expect(digest).not.toContain(DIGEST_FOOTER);
  });

  it('页脚教会用户「用序号精确反馈」，而不只是整批赞踩', async () => {
    dbMock.executeRows.push(makeEntry('a/one'));

    const digest = await buildDigestForSubscriber(makeSub());

    expect(DIGEST_FOOTER).toBe(
      '💡 「收藏 3」收藏第 3 条；「不感兴趣 3」只针对它；「我的订阅」看设置；「帮助」看全部',
    );
    expect(digest.endsWith(DIGEST_FOOTER)).toBe(true);
  });

  it('每条恰好一行（链接 + ★ + 增量 +（新上榜），不再有「为什么上榜」两行块）', async () => {
    dbMock.executeRows.push(
      makeEntry('a/fresh', { isNew: true, starsDelta: 500 }),
      makeEntry('b/veteran', { starsDelta: 800 }),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain(
      '1. a/fresh ★1000 (+500)（新上榜）',
    );
    expect(digest).toContain(
      '2. b/veteran ★1000 (+800)',
    );
    expect(digest).not.toContain('为什么上榜');
    // 单行纪律：除头部/空行/页脚外，每条条目不产生额外换行
    expect(digest).not.toMatch(/\n\s{2,}\S/);
  });

  it('loadRepoSummaries 注入：命中的仓库行尾追加「 — 中文简介」', async () => {
    dbMock.executeRows.push(
      makeEntry('a/fresh', { starsDelta: 500 }),
      makeEntry('b/veteran', { starsDelta: 800 }),
    );
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map([['a/fresh', '新锐 AI 框架']]),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(summaryMock.loadRepoSummaries).toHaveBeenCalledTimes(1);
    expect(digest).toContain(
      '1. a/fresh ★1000 (+500) — 新锐 AI 框架',
    );
    // 未命中的仓库省略破折号后段（链接仍然在行尾）
    expect(digest).toContain(
      '2. b/veteran ★1000 (+800) https://github.com/b/veteran',
    );
  });

  it('简介降级（loadRepoSummaries 返回空 Map）→ 无破折号后段，仍含完整 repo 列表', async () => {
    summaryMock.loadRepoSummaries.mockResolvedValue(new Map());
    dbMock.executeRows.push(
      makeEntry('vercel/next.js', { stars: 128000, starsDelta: 321 }),
      makeEntry('rust-lang/rust', { isNew: true, stars: 99000, starsDelta: 100 }),
    );

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain(
      '1. vercel/next.js ★128000 (+321)',
    );
    expect(digest).toContain(
      '2. rust-lang/rust ★99000 (+100)（新上榜）',
    );
    expect(digest).not.toContain(' — ');
    expect(digest).toContain('📊 今日 GitHub 热榜简报（');
  });

  it('loadRepoSummaries 抛错 → 降级输出 repo 列表（摘要失败不吞简报）', async () => {
    summaryMock.loadRepoSummaries.mockRejectedValue(new Error('llm exploded'));
    dbMock.executeRows.push(makeEntry('x/y', { stars: 10, starsDelta: 5 }));

    const digest = await buildDigestForSubscriber(makeSub());

    expect(digest).toContain('1. x/y ★10 (+5');
  });

  it('超长内容截断到 1900 字节内并标注，首条保留', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`owner${i}/repo-with-a-rather-long-name-${i}`, {
        stars: 123456,
        starsDelta: 2345,
      }),
    );
    dbMock.executeRows.push(...entries);
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map(
        entries.map((e, i) => [
          String(e.fullName),
          `这是一段很长的上榜理由编号${i}，用来撑爆字节上限。`.repeat(4),
        ]),
      ),
    );

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 20 },
      }),
    );

    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(1900);
    expect(digest).toContain('（内容过长，已截断）');
    expect(digest).toContain('owner0/repo-with-a-rather-long-name-0');
    expect(digest).not.toContain('owner19/repo-with-a-rather-long-name-19');
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

  it('normalizePreferences：存量 keywords 带尾标点（"AI。"）读取时清洗为 "ai"（languages 不清洗）', async () => {
    dbMock.executeRows.push(
      makeEntry('big/stars', { starsDelta: 900 }),
      makeEntry('ai/tool', { starsDelta: 50 }),
    );

    const digest = await buildDigestForSubscriber(
      makeSub({
        preferences: { languages: ['Python。'], keywords: ['AI。'] },
      }),
    );

    // 清洗后 "AI。" → "ai" 命中 ai/tool，轻量排序把它提到 big/stars 前面；
    // 若读取侧不清洗（旧 bug），"ai。" 匹配不到任何条目，顺序保持 stars_delta。
    expect(digest.indexOf('ai/tool')).toBeLessThan(digest.indexOf('big/stars'));
    // languages 逻辑不变：标点不清洗 → 'python。' 不匹配任何仓库语言。
    const compiled = compileQuery(dbMock.executeQueries[0]);
    expect(compiled.params).toContain('python。');
  });
});

// ---------------------------------------------------------------------------
// buildDigestWithEntries —— 可收藏条目与消息实际展示一致（排序 + digestCount + 1900 截断）
// ---------------------------------------------------------------------------
describe('buildDigestWithEntries — entries 与消息展示一致', () => {
  it('entries 顺序与消息行一致（digestCount 截断后的前 N 条）', async () => {
    for (let i = 1; i <= 5; i += 1) {
      dbMock.executeRows.push(makeEntry(`o/r${i}`, { starsDelta: 1000 - i }));
    }

    const { content, entries } = await buildDigestWithEntries(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 3 } }),
      new Date('2026-10-22T16:30:00Z'),
    );

    expect(content).toBe(await buildDigestForSubscriber(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 3 } }),
      new Date('2026-10-22T16:30:00Z'),
    ));
    expect(entries).toEqual([
      { fullName: 'o/r1' },
      { fullName: 'o/r2' },
      { fullName: 'o/r3' },
    ]);
  });

  it('1900 字节截断后 entries 只含实际展示的条目（被丢弃的尾部条目不进缓存）', async () => {
    const entriesRows = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`owner${i}/repo-with-a-rather-long-name-${i}`, {
        stars: 123456,
        starsDelta: 2345,
      }),
    );
    dbMock.executeRows.push(...entriesRows);
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map(
        entriesRows.map((e, i) => [
          String(e.fullName),
          `这是一段很长的上榜理由编号${i}，用来撑爆字节上限。`.repeat(4),
        ]),
      ),
    );

    const { content, entries } = await buildDigestWithEntries(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 20 },
      }),
    );

    expect(content).toContain('（内容过长，已截断）');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(8);
    expect(entries[0]).toEqual({ fullName: 'owner0/repo-with-a-rather-long-name-0' });
    // 每个 entries 条目都必须真实出现在消息里；被丢弃的最后一条不得出现。
    for (const entry of entries) {
      expect(content).toContain(entry.fullName);
    }
    expect(entries.map((e) => e.fullName)).not.toContain(
      'owner19/repo-with-a-rather-long-name-19',
    );
    expect(content).not.toContain('owner19/repo-with-a-rather-long-name-19');
  });

  it('有概览时，概览作为开头段落出现在标题与条目之间', async () => {
    dbMock.executeRows.push(makeEntry('o/r1', { starsDelta: 100 }));
    abstractMock.loadAbstractSafe.mockResolvedValue('今天的榜单集中在 AI 工具上。');

    const { content } = await buildDigestWithEntries(makeSub());

    const lines = content.split('\n');
    expect(lines[0]).toContain('📊 今日 GitHub 热榜简报');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('今天的榜单集中在 AI 工具上。');
    expect(lines[3]).toBe('');
    expect(lines[4]).toContain('o/r1');
  });

  it('空榜 → { content: 占位文案, entries: [] }', async () => {    const { content, entries } = await buildDigestWithEntries(
      makeSub(),
      new Date('2026-10-22T16:30:00Z'),
    );

    expect(entries).toEqual([]);
    expect(content).toBe(
      '📊 今日 GitHub 热榜简报（2026-10-23）\n\n今日暂无符合条件的热榜项目。',
    );
  });
});

// ---------------------------------------------------------------------------
// buildDigestFromSnapshot —— 快照优先（企微仍走 1900 字节截断）
// ---------------------------------------------------------------------------
function makeSnapshotItem(
  fullName: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    fullName,
    description: null,
    topics: [],
    language: 'rust',
    stars: 100,
    starsDelta: 10,
    isNew: false,
    htmlUrl: `https://github.com/${fullName}`,
    summary: `${fullName} 的中文简介。`,
    ...overrides,
  };
}

describe('buildDigestFromSnapshot — 快照优先', () => {
  const snapshot = {
    date: '2026-10-25',
    dataDate: '2026-10-25',
    abstract: '今天的主题是 AI 工具。',
    items: [
      makeSnapshotItem('s/one', { language: 'rust' }),
      makeSnapshotItem('s/two', { language: 'typescript' }),
    ],
  };

  it('selects with the same preference semantics and prefixes the abstract', async () => {
    const { content, entries } = await buildDigestFromSnapshot(
      makeSub({
        preferences: { languages: ['rust'], keywords: [], digestCount: 5 },
      }),
      snapshot,
    );

    expect(content).toContain('📊 今日 GitHub 热榜简报（2026-10-25）');
    expect(content).toContain('今天的主题是 AI 工具。');
    expect(content).toContain('s/one');
    expect(content).toContain('s/one 的中文简介。');
    expect(content).not.toContain('s/two');
    expect(entries).toEqual([{ fullName: 's/one' }]);
  });

  it('keeps the 1900-byte truncation and reports only the shown entries', async () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      makeSnapshotItem(`owner${index}/repo-with-a-rather-long-name-${index}`, {
        stars: 123456,
        starsDelta: 2345,
        summary: `这是一段很长的上榜理由编号${index}，用来撑爆字节上限。`.repeat(4),
      }),
    );
    const { content, entries } = await buildDigestFromSnapshot(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 20 },
      }),
      { date: '2026-10-25', dataDate: '2026-10-25', abstract: null, items },
    );

    expect(content).toContain('（内容过长，已截断）');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(8);
    for (const entry of entries) {
      expect(content).toContain(entry.fullName);
    }
    expect(content).not.toContain('owner19/repo-with-a-rather-long-name-19');
  });

  it('falls back to the empty notice when nothing matches', async () => {
    const { content, entries } = await buildDigestFromSnapshot(
      makeSub({ preferences: { languages: ['go'], keywords: [], digestCount: 5 } }),
      snapshot,
    );
    expect(content).toContain('今日暂无符合条件的热榜项目。');
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// news 卡片：企微简报的主格式（纯文本只在 news 发送失败时兜底）
// ---------------------------------------------------------------------------
describe('buildDigestNewsFromSnapshot — news 卡片', () => {
  it('最多 8 篇，entries 与卡片顺序一致', async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeSnapshotItem(`s/${i}`, { starsDelta: 1000 - i }),
    );

    const { articles, entries } = await buildDigestNewsFromSnapshot(
      makeSub({ preferences: { languages: [], keywords: [], digestCount: 20 } }),
      { date: '2026-10-28', dataDate: null, abstract: null, items },
      { baseUrl: 'https://ghtrending.cyou' },
    );

    expect(articles).toHaveLength(8);
    expect(entries.map((entry) => entry.fullName)).toEqual(
      Array.from({ length: 8 }, (_, i) => `s/${i}`),
    );
    expect(articles[0].picurl).toBe('https://opengraph.githubassets.com/1/s/0');
    expect(articles[1].picurl).toContain('https://ghtrending.cyou/api/tile?repo=s%2F1');
  });

  it('accept 在截取之前生效：不合格条目不占名额、也不被补位', async () => {
    const items = Array.from({ length: 5 }, (_, i) => makeSnapshotItem(`s/${i}`));

    const { entries } = await buildDigestNewsFromSnapshot(
      makeSub(),
      { date: '2026-10-28', dataDate: null, abstract: null, items },
      {
        baseUrl: 'https://ghtrending.cyou',
        accept: (item) => item.fullName !== 's/0',
      },
    );

    expect(entries.map((entry) => entry.fullName)).toEqual(['s/1', 's/2', 's/3', 's/4']);
  });
});

describe('pushDigests — news 主格式与纯文本兜底', () => {
  const previousVercelUrl = process.env.VERCEL_URL;

  afterEach(() => {
    if (previousVercelUrl === undefined) {
      delete process.env.VERCEL_URL;
    } else {
      process.env.VERCEL_URL = previousVercelUrl;
    }
  });

  function snapshotWithOne(): void {
    snapshotMock.getDailySnapshot.mockResolvedValueOnce({
      date: '2026-10-28',
      dataDate: '2026-10-28',
      abstract: '快照里的今日概览。',
      items: [makeSnapshotItem('s/one', { starsDelta: 240 })],
    });
    dbMock.selectRows.push(makeSub());
    dbMock.claimResults.push([{ id: 1 }]);
  }

  it('有站点域名时发 news 卡片，不发纯文本', async () => {
    process.env.VERCEL_URL = 'ghtrending.cyou';
    snapshotWithOne();

    const result = await pushDigests(new Date('2026-10-28T01:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    const [userid, articles] = apiMock.sendWeComNews.mock.calls[0] as [
      string,
      Array<{ title: string; picurl: string }>,
    ];
    expect(userid).toBe('alice');
    expect(articles).toHaveLength(1);
    expect(articles[0].picurl).toBe('https://opengraph.githubassets.com/1/s/one');
    const saved = dbMock.insertCalls.find((call) => call.table === searchCaches);
    expect(saved?.values).toEqual({
      wecomUserid: 'alice',
      results: [{ fullName: 's/one' }],
    });
  });

  it('news 发送失败 → 回退纯文本，条目仍与消息一致，且只发一次', async () => {
    process.env.VERCEL_URL = 'ghtrending.cyou';
    snapshotWithOne();
    apiMock.sendWeComNews.mockRejectedValueOnce(new Error('45008'));

    const result = await pushDigests(new Date('2026-10-28T01:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComNews).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const content = apiMock.sendWeComText.mock.calls[0][1] as string;
    expect(content).toContain('s/one');
    const saved = dbMock.insertCalls.find((call) => call.table === searchCaches);
    expect(saved?.values).toEqual({
      wecomUserid: 'alice',
      results: [{ fullName: 's/one' }],
    });
  });

  it('没有站点域名（本地/测试）→ 直接纯文本，不构造相对图片 URL', async () => {
    delete process.env.VERCEL_URL;
    snapshotWithOne();

    const result = await pushDigests(new Date('2026-10-28T01:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComNews).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });
});

describe('pushDigests — 快照可用时优先且不查 trending 表', () => {
  it('sends the snapshot content without executing the fallback SQL', async () => {
    snapshotMock.getDailySnapshot.mockResolvedValueOnce({
      date: '2026-10-25',
      dataDate: '2026-10-25',
      abstract: '快照里的今日概览。',
      items: [makeSnapshotItem('s/one', { starsDelta: 240 })],
    });
    dbMock.selectRows.push(makeSub());
    dbMock.claimResults.push([{ id: 1 }]);

    const result = await pushDigests(new Date('2026-10-25T01:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(dbMock.executeQueries).toHaveLength(0);
    const content = apiMock.sendWeComText.mock.calls[0][1] as string;
    expect(content).toContain('快照里的今日概览。');
    expect(content).toContain('s/one');
    // 简报写入 search_caches 的 entries 与消息展示一致。
    const cached = dbMock.insertCalls.find((call) => call.table === searchCaches);
    expect(cached?.values.results).toEqual([{ fullName: 's/one' }]);
  });
});


describe('saveRecentResults — search_caches 覆盖写', () => {
  it('非空 items：先 delete 该用户全部行，再 insert 一行 { fullName }[]', async () => {
    await saveRecentResults('alice', [
      { fullName: 'a/one' },
      { fullName: 'b/two' },
    ]);

    expect(dbMock.deleteCalls).toHaveLength(1);
    expect(dbMock.deleteCalls[0]?.table).toBe(searchCaches);
    const delCompiled = compileQuery(dbMock.deleteCalls[0]?.condition);
    expect(delCompiled.sql).toContain('"search_caches"."wecom_userid"');
    expect(delCompiled.params).toContain('alice');

    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.table).toBe(searchCaches);
    expect(dbMock.insertCalls[0]?.values).toEqual({
      wecomUserid: 'alice',
      results: [{ fullName: 'a/one' }, { fullName: 'b/two' }],
    });
  });

  it('空 items → 不写（delete/insert 都不发生）', async () => {
    await saveRecentResults('alice', []);

    expect(dbMock.deleteCalls).toHaveLength(0);
    expect(dbMock.insertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 推送成功后写 search_caches（「收藏 N」引用刚收到的简报）
// ---------------------------------------------------------------------------
describe('pushDigests — 推送后写 search_caches（收藏一致性）', () => {
  it('发送成功 → 按展示顺序写该用户的 search_caches（delete + insert 各一次）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(dbMock.deleteCalls).toHaveLength(1);
    expect(dbMock.deleteCalls[0]?.table).toBe(searchCaches);
    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.table).toBe(searchCaches);
    expect(dbMock.insertCalls[0]?.values).toEqual({
      wecomUserid: 'alice',
      results: [{ fullName: 'a/one' }, { fullName: 'b/two' }],
    });
  });

  it('1900 截断丢弃的尾部条目不写入缓存（收藏序号绝不指向消息里看不到的条目）', async () => {
    const entriesRows = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`owner${i}/repo-with-a-rather-long-name-${i}`, {
        stars: 123456,
        starsDelta: 2345,
      }),
    );
    dbMock.selectRows.push(
      makeSub({
        preferences: { languages: [], keywords: [], digestCount: 20, pushTime: '00:00' },
      }),
    );
    dbMock.executeRows.push(...entriesRows);
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map(
        entriesRows.map((e, i) => [
          String(e.fullName),
          `这是一段很长的上榜理由编号${i}，用来撑爆字节上限。`.repeat(4),
        ]),
      ),
    );

    await pushDigests();

    const results = dbMock.insertCalls[0]?.values.results as Array<{ fullName: string }>;
    expect(results.length).toBeLessThan(8);
    expect(results[0]?.fullName).toBe('owner0/repo-with-a-rather-long-name-0');
    expect(results.map((r) => r.fullName)).not.toContain(
      'owner19/repo-with-a-rather-long-name-19',
    );
  });

  it('发送失败 → 不写缓存（绝不让「收藏 N」引用用户没收到的列表）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(dbMock.deleteCalls).toHaveLength(0);
    expect(dbMock.insertCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('空榜 → 不发空简报、不写缓存（静默，且保留用户上一次有效缓存）', async () => {
    dbMock.selectRows.push(makeSub());

    const result = await pushDigests();

    // 没有历史（部署首日）→ 静默：不自作主张发「今日暂无」。
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toHaveLength(0);
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('整轮超出时间预算 → 剩余订阅者不抢占也不发送，留给下一个整点', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    let ticks = 0;
    const result = await pushDigests(new Date(), {
      budgetMs: 100,
      clock: () => (ticks += 1000),
    });

    // 第一次预检就已超预算：两个人都不该被处理，更不能被抢占。
    expect(result).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('部分成功：失败的订阅者不写、成功的订阅者照写', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));
    apiMock.sendWeComText
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('wecom down'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.values).toMatchObject({ wecomUserid: 'alice' });
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 缓存写失败 → best-effort 失效旧缓存（陈旧非空行绝不残留）
// ---------------------------------------------------------------------------
describe('pushDigests — 缓存写失败的 best-effort 失效', () => {
  it('saveRecentResults 失败（insert 抛错）→ 再 delete 该用户行做失效、计数不变、只发送一次', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    dbMock.insertError = new Error('insert down');

    const result = await pushDigests();

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    // save 的 delete（成功）+ invalidate 的 delete；两次都按用户隔离删 search_caches。
    expect(dbMock.deleteCalls).toHaveLength(2);
    for (const call of dbMock.deleteCalls) {
      expect(call.table).toBe(searchCaches);
      const compiled = compileQuery(call.condition);
      expect(compiled.params).toContain('alice');
    }
    expect(console.error).toHaveBeenCalledWith(
      'saveRecentResults failed for alice:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('失效 delete 也抛错 → 吞掉不外抛，计数不变（DB 全挂也不能冲出 pushDigests）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    dbMock.deleteError = new Error('db down');

    const result = await pushDigests();

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      'saveRecentResults failed for alice:',
      expect.any(Error),
    );
    expect(console.error).toHaveBeenCalledWith(
      'invalidateRecentResults failed for alice:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('invalidateRecentResults：按 wecom_userid delete 该用户 search_caches 行', async () => {
    await invalidateRecentResults('alice');

    expect(dbMock.deleteCalls).toHaveLength(1);
    expect(dbMock.deleteCalls[0]?.table).toBe(searchCaches);
    const compiled = compileQuery(dbMock.deleteCalls[0]?.condition);
    expect(compiled.sql).toContain('"search_caches"."wecom_userid"');
    expect(compiled.params).toContain('alice');
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 遍历 active 订阅者，单个失败不中断，走 文本通道
// ---------------------------------------------------------------------------
describe('pushDigests — 推送计数与容错', () => {
  it('订阅查询按 active = true 过滤', async () => {
    await pushDigests();

    const compiled = compileQuery(dbMock.selectConditions[0]);
    expect(compiled.sql).toMatch(/"subscribers"\."active"\s*=\s*(\$1|true)/);
  });

  it('全部成功 → { sent: n, failed: 0 }，逐个经 sendWeComText 发送', async () => {
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 2, skipped: 0, failed: 0 });
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

    expect(result).toEqual({ sent: 2, skipped: 0, failed: 1 });
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
// 北京时间工具函数（Task 5：推送时间门控；h23 —— 午夜绝不出现 24:00）
// ---------------------------------------------------------------------------
describe('北京时间工具函数', () => {
  it('shanghaiHHMM：UTC 16:00（北京次日 00:00）→ "00:00"（h23，绝不出现 24:00）', () => {
    expect(shanghaiHHMM(new Date('2026-10-22T16:00:00Z'))).toBe('00:00');
  });

  it('shanghaiHHMM：北京 09:05 → "09:05"（补零）', () => {
    expect(shanghaiHHMM(new Date('2026-10-22T01:05:00Z'))).toBe('09:05');
  });

  it('shanghaiMinutes：北京 23:59 → 1439；00:00 → 0', () => {
    expect(shanghaiMinutes(new Date('2026-10-22T15:59:00Z'))).toBe(1439);
    expect(shanghaiMinutes(new Date('2026-10-22T16:00:00Z'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 推送时间/间隔门控 + 条件抢占 + 失败回滚（Task 5）
// ---------------------------------------------------------------------------
describe('pushDigests — 推送时间/间隔门控与抢占', () => {
  /** 北京时间 2026-10-23 08:30（pushTime 09:00 未到）。 */
  const BEFORE_PUSH = new Date('2026-10-23T00:30:00Z');
  /** 北京时间 2026-10-23 09:00（恰好到点）。 */
  const AT_PUSH = new Date('2026-10-23T01:00:00Z');

  function subWith(
    preferences: Record<string, unknown>,
    overrides: Partial<SubscriberRow> = {},
  ): SubscriberRow {
    return makeSub({
      preferences:
        preferences as SubscriberRow['preferences'],
      ...overrides,
    });
  }

  it('pushTime 09:00 未到（北京 08:30）→ 不构建、不抢占、不发送，{sent:0, skipped:1, failed:0}', async () => {
    dbMock.selectRows.push(
      subWith({ languages: [], keywords: [], pushTime: '09:00' }),
    );

    const result = await pushDigests(BEFORE_PUSH);

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(0);
    expect(dbMock.executeQueries).toHaveLength(0);
  });

  it('pushTime 09:00 恰好到点（nowMin == pushMin，>= 语义）→ 发送', async () => {
    dbMock.selectRows.push(
      subWith({ languages: [], keywords: [], pushTime: '09:00' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    const result = await pushDigests(AT_PUSH);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    // 成功发送绝不移交回滚：只有抢占（claim）的 update，没有普通 update。
    // （mutation：把回滚移进 finally 会让这里变红——那会造成每个整点重复推送。）
    expect(dbMock.updateCalls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('pushTime 09:30 的分钟位参与门控：北京 09:29 不发、09:30 发', async () => {
    dbMock.selectRows.push(
      subWith({ languages: [], keywords: [], pushTime: '09:30' }),
    );

    const before = await pushDigests(new Date('2026-10-23T01:29:00Z')); // 北京 09:29
    expect(before).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(0);

    dbMock.executeRows.push(makeEntry('a/one'));
    const at = await pushDigests(new Date('2026-10-23T01:30:00Z')); // 北京 09:30
    expect(at).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('当天已发（last_digest_at 为北京当日）→ 不重发、不抢占', async () => {
    dbMock.selectRows.push(
      makeSub({ lastDigestAt: new Date('2026-10-23T01:00:00Z') }),
    );

    // 北京 2026-10-23 14:00：同日已发过。
    const result = await pushDigests(new Date('2026-10-23T06:00:00Z'));

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(0);
  });

  it('intervalDays=2：上次北京 10-21 09:00 → 次日（10-22）不发', async () => {
    dbMock.selectRows.push(
      subWith(
        { languages: [], keywords: [], pushTime: '00:00', intervalDays: 2 },
        { lastDigestAt: new Date('2026-10-21T01:00:00Z') },
      ),
    );

    // 北京 2026-10-22 10:00：跨日但未满 2 天。
    const result = await pushDigests(new Date('2026-10-22T02:00:00Z'));

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(0);
  });

  it('intervalDays=2：第三天（10-23）满间隔 → 抢占成功并发送', async () => {
    dbMock.selectRows.push(
      subWith(
        { languages: [], keywords: [], pushTime: '00:00', intervalDays: 2 },
        { lastDigestAt: new Date('2026-10-21T01:00:00Z') },
      ),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    // 北京 2026-10-23 10:00：距上次（10-21 09:00）已满 2 天。
    const result = await pushDigests(new Date('2026-10-23T02:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const claims = dbMock.updateCalls.filter((c) => c.kind === 'claim');
    expect(claims).toHaveLength(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('并发抢占：claim 仅第一次返回行 → 两次 pushDigests 只有第一次发送', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    // 模拟条件 UPDATE 的原子性：第一次抢到（返回行），第二次 0 行。
    dbMock.claimResults.push([{ id: 1 }], []);

    const first = await pushDigests(AT_PUSH);
    const second = await pushDigests(AT_PUSH);

    expect(first).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(second).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(dbMock.updateCalls.filter((c) => c.kind === 'claim')).toHaveLength(2);
    expect(dbMock.insertCalls).toHaveLength(1); // 只有第一次成功者写缓存
  });

  it('发送失败 → 回滚 last_digest_at = NULL（下一小时重试）+ failed，不写缓存', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    const result = await pushDigests(AT_PUSH);

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    const claim = dbMock.updateCalls.find((c) => c.kind === 'claim');
    expect(claim).toBeDefined();
    const rollback = dbMock.updateCalls.find((c) => c.kind === 'update');
    expect(rollback).toBeDefined();
    expect(rollback?.values).toEqual({ lastDigestAt: null });
    const compiled = compileQuery(rollback?.condition);
    expect(compiled.sql).toContain('"subscribers"."id"');
    expect(compiled.params).toContain(1);
    // 发送失败绝不写缓存。
    expect(dbMock.deleteCalls).toHaveLength(0);
    expect(dbMock.insertCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('构建失败（digest 查询抛错）→ 同样回滚 last_digest_at', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(makeSub());
    dbMock.executeError = new Error('db down');

    const result = await pushDigests(AT_PUSH);

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    const rollback = dbMock.updateCalls.find((c) => c.kind === 'update');
    expect(rollback?.values).toEqual({ lastDigestAt: null });
    errorSpy.mockRestore();
  });

  it('抢占 SQL 形状：北京日期差 >= intervalDays（不再用 now() - make_interval）', async () => {
    dbMock.selectRows.push(
      subWith({ languages: [], keywords: [], pushTime: '00:00', intervalDays: 3 }, { id: 7 }),
    );

    await pushDigests(AT_PUSH);

    const claim = dbMock.updateCalls.find((c) => c.kind === 'claim');
    expect(claim).toBeDefined();
    const compiled = compileQuery(claim?.condition);
    expect(compiled.sql).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(compiled.sql).toContain('"subscribers"."last_digest_at"');
    expect(compiled.sql).toContain('"subscribers"."active"');
    expect(compiled.params).toContain(7); // id
    expect(compiled.params).toContain(3); // intervalDays
    // 日期比较的**方向**必须钉死：上次北京日期 < 今天（而不是 >）。
    // mutation：把 `<` 翻成 `>` 时本断言变红——那会让所有老用户永久 skipped（只发首日）。
    const normalized = compiled.sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      `"subscribers"."last_digest_at" AT TIME ZONE 'Asia/Shanghai')::date < (now() AT TIME ZONE 'Asia/Shanghai')::date`,
    );
    expect(normalized).not.toContain(')::date > (');
    // 间隔按日历日：date - date → integer，与 JS 门控同语义。
    // mutation：换回 `last_digest_at <= now() - make_interval(days => N)` 时
    // 下面两条变红——那正是「一次 tick 延迟让推送时间永久后移」的成因。
    expect(normalized).not.toContain('make_interval');
    expect(normalized).toContain(')::date - (');
    expect(normalized).toContain(')::date) >= $');
    // SET last_digest_at = now()（DB 时钟，与条件里的 now() 同源）
    const setValue = compileQuery(claim?.values.lastDigestAt);
    expect(setValue.sql).toContain('now()');
  });

  it('pushTime 非法（"99:99"）→ 按默认 09:00 门控：08:59 不发、09:00 发', async () => {
    dbMock.selectRows.push(
      subWith({ languages: [], keywords: [], pushTime: '99:99' }),
    );

    const before = await pushDigests(new Date('2026-10-23T00:59:00Z')); // 北京 08:59
    expect(before).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();

    dbMock.executeRows.push(makeEntry('a/one'));
    const after = await pushDigests(new Date('2026-10-23T01:00:00Z')); // 北京 09:00
    expect(after).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('intervalDays 超上限（99）→ 按默认 1 天门控：昨天到点已发、今天到点即发', async () => {
    dbMock.selectRows.push(
      subWith(
        { languages: [], keywords: [], pushTime: '00:00', intervalDays: 99 },
        { lastDigestAt: new Date('2026-10-22T01:00:00Z') }, // 北京 10-22 09:00
      ),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    // 北京 10-23 09:00：若 99 被保留/截到 30 都不会发；按 1 才发。
    const result = await pushDigests(new Date('2026-10-23T01:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it('intervalDays 非法（0）→ 按默认 1 天：跨天即发（不是等满 24 小时）', async () => {
    dbMock.selectRows.push(
      subWith(
        { languages: [], keywords: [], pushTime: '00:00', intervalDays: 0 },
        { lastDigestAt: new Date('2026-10-22T02:00:00Z') }, // 北京 10-22 10:00
      ),
    );
    dbMock.executeRows.push(makeEntry('a/one'));

    // 北京 10-23 09:00：跨了一个日历日 → 按默认 1 天发。
    // （若 0 被当作 0 天间隔，同日就发，由「同一天不发两条」那条用例守住。）
    const result = await pushDigests(new Date('2026-10-23T01:00:00Z'));

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 间隔按「北京日历日」判定，不是精确 24 小时。
  //
  // 为什么：claim 把 last_digest_at 写成**实际发送时刻**。若再要求「距上次满
  // 24 小时」，任何一次 tick 延迟（GitHub Actions 实测晚十几分钟）都会让次日
  // 09:17 因为差几分钟被跳过，实际推送时间从此永久后移一小时——而且再也回不去。
  // 用户选的是「每天 09:00 左右收到」，不是「距上次满 24 小时」。
  // -------------------------------------------------------------------------
  describe('间隔按日历日而不是精确 24 小时', () => {
    it('昨天 21:00 发过 → 今天 09:17 照常发（不足 24 小时也要发）', async () => {
      dbMock.selectRows.push(
        subWith(
          { languages: [], keywords: [], pushTime: '09:00' },
          { lastDigestAt: new Date('2026-10-22T13:00:00Z') }, // 北京 10-22 21:00
        ),
      );
      dbMock.executeRows.push(makeEntry('a/one'));

      // 北京 10-23 09:17：距上次只有 12 小时 17 分。
      const result = await pushDigests(new Date('2026-10-23T01:17:00Z'));

      expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
      expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    });

    it('昨天 23:59 发过 → 今天 00:05 照常发（跨日只差 6 分钟）', async () => {
      dbMock.selectRows.push(
        subWith(
          { languages: [], keywords: [], pushTime: '00:00' },
          { lastDigestAt: new Date('2026-10-22T15:59:00Z') }, // 北京 10-22 23:59
        ),
      );
      dbMock.executeRows.push(makeEntry('a/one'));

      const result = await pushDigests(new Date('2026-10-22T16:05:00Z')); // 北京 10-23 00:05

      expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    });

    it('跨月：9-30 21:00 发过 → 10-01 09:17 发', async () => {
      dbMock.selectRows.push(
        subWith(
          { languages: [], keywords: [], pushTime: '09:00' },
          { lastDigestAt: new Date('2026-09-30T13:00:00Z') }, // 北京 09-30 21:00
        ),
      );
      dbMock.executeRows.push(makeEntry('a/one'));

      const result = await pushDigests(new Date('2026-10-01T01:17:00Z')); // 北京 10-01 09:17

      expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    });

    it('跨年：12-31 21:00 发过 → 次年 01-01 09:17 发', async () => {
      dbMock.selectRows.push(
        subWith(
          { languages: [], keywords: [], pushTime: '09:00' },
          { lastDigestAt: new Date('2026-12-31T13:00:00Z') }, // 北京 12-31 21:00
        ),
      );
      dbMock.executeRows.push(makeEntry('a/one'));

      const result = await pushDigests(new Date('2027-01-01T01:17:00Z')); // 北京 01-01 09:17

      expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    });

    it('同一天只发一条：今天 09:17 发过 → 今天 22:00 不再发', async () => {
      dbMock.selectRows.push(
        subWith(
          { languages: [], keywords: [], pushTime: '00:00' },
          { lastDigestAt: new Date('2026-10-23T01:17:00Z') }, // 北京 10-23 09:17
        ),
      );

      const result = await pushDigests(new Date('2026-10-23T14:00:00Z')); // 北京 10-23 22:00

      expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
      expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    });

    it('last_digest_at 落在未来（时钟偏移）→ 不发', async () => {
      dbMock.selectRows.push(
        subWith(
          { languages: [], keywords: [], pushTime: '00:00' },
          { lastDigestAt: new Date('2026-10-24T01:00:00Z') }, // 北京 10-24，晚于今天
        ),
      );

      const result = await pushDigests(new Date('2026-10-23T01:17:00Z'));

      expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// markDigestSent —— 首日简报（加入即送）记账
// ---------------------------------------------------------------------------
describe('markDigestSent — 首日简报发送成功后的当日去重', () => {
  it('按 wecom_userid 回填「北京当日 00:00」（不是 now()，否则 24h 间隔门控会把推送时间永久漂移）', async () => {
    await markDigestSent('alice');

    expect(dbMock.updateCalls).toHaveLength(1);
    const update = dbMock.updateCalls[0]!;
    expect(update.kind).toBe('update');
    expect(update.table).toBe(subscribers);
    const setValue = compileQuery(update.values.lastDigestAt);
    // 关键不变量：回填的是北京墙钟的当日零点，再转回 timestamptz。
    // mutation：改回 now() → 本断言变红（14:00 入场的用户次日 09:00 永远收不到）。
    const normalized = setValue.sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'",
    );
    expect(normalized).not.toMatch(/^now\(\)$/);

    const compiled = compileQuery(update.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');
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
    expect(summaryMock.loadRepoSummaries).not.toHaveBeenCalled();
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

  it('Bearer <CRON_SECRET> 正确 → 执行 pushDigests 并返回 {sent, skipped, failed, email, weekly} JSON', async () => {
    dbMock.selectRows.push(
      makeSub(),
      makeSub({ id: 2, wecomUserid: 'bob' }),
    );
    dbMock.executeRows.push(makeEntry('a/one'));
    const res = mockRes();

    await handler(cronReq('Bearer unit-test-cron-secret'), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({
      sent: 2,
      skipped: 0,
      failed: 0,
      email: { sent: 0, skipped: 0, failed: 0 },
      weekly: { sent: 0, skipped: 0, failed: 0 },
    });
    expect(weeklyMock.pushWeeklyReviews).toHaveBeenCalledTimes(1);
    expect(res.headers['content-type']).toContain('application/json');
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    // 两个渠道共用同一份快照：cron 读一次、pushDigests 内再读一次，
    // 第二次命中 kv_cache（真实环境每天只构建一轮模型）。
    expect(snapshotMock.getDailySnapshot).toHaveBeenCalledTimes(2);
    // cron 请求没有用户头，站点根地址由 resolveBaseUrl 兜底后显式传入，
    // 否则邮件里的设置/退订链接会回落 localhost。
    expect(emailPushMock.pushEmailDigests).toHaveBeenCalledWith({
      snapshot: null,
      baseUrl: 'http://localhost:3000',
    });
    expect(capacityMock.refreshWeComMemberCount).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Vercel Node 函数配置：maxDuration 经 export 生效（不引入 vercel.json）
// ---------------------------------------------------------------------------
describe('api/cron-push-digest — 函数时长上限', () => {
  it('导出 maxDuration = 300（秒；串行简报超过默认上限会尾部丢消息）', () => {
    expect(maxDuration).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// pushDigests —— 只推新的（收藏 / 7 天去重 / 增长门槛 / 静默）
// ---------------------------------------------------------------------------
describe('pushDigests — 只推新的', () => {
  const DAY = 24 * 3600 * 1000;

  function sendHistory(daysAgo: number, items: Array<[string, number]> = []): void {
    historyMock.readPushHistory.mockResolvedValue({
      items: items.map(([fullName, days]) => ({
        fullName,
        at: new Date(Date.now() - days * DAY).toISOString(),
      })),
      lastSentAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    });
  }

  it('已收藏的仓库不再出现在简报里（用户已经知道了）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));
    tasteMock.loadUserSignalsStrict.mockResolvedValue(
      composeSignals([{ fullName: 'a/one', language: 'Go', topics: [] }], []),
    );

    const result = await pushDigests();

    expect(result.sent).toBe(1);
    const sent = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(sent).toContain('b/two');
    expect(sent).not.toContain('a/one');
    expect(dbMock.insertCalls[0]?.values).toEqual({
      wecomUserid: 'alice',
      results: [{ fullName: 'b/two' }],
    });
  });

  it('7 天内推过的被跳过；第 8 天的仍然出现', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/recent'), makeEntry('b/old'));
    sendHistory(2, [
      ['a/recent', 2],
      ['b/old', 9],
    ]);

    await pushDigests();

    const sent = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(sent).toContain('b/old');
    expect(sent).not.toContain('a/recent');
  });

  it('增长不够且不是新项目 → 不推（长尾噪音）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/flat', { starsDelta: 3, isNew: false }));
    sendHistory(1);

    const result = await pushDigests();

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('全部被过滤 + 3 天内发过 → 零发送、不回滚 claim、不写 search_caches', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    tasteMock.loadUserSignalsStrict.mockResolvedValue(
      composeSignals([{ fullName: 'a/one', language: 'Go', topics: [] }], []),
    );
    sendHistory(1);

    const result = await pushDigests();

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
    // 静默不是失败：抢占保留，当天不再每小时重试。
    expect(dbMock.updateCalls.filter((call) => call.kind === 'update')).toHaveLength(0);
  });

  it(`距上次 ≥${QUIET_NOTE_AFTER_DAYS} 天 → 只发一句补助，不写 search_caches`, async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    tasteMock.loadUserSignalsStrict.mockResolvedValue(
      composeSignals([{ fullName: 'a/one', language: 'Go', topics: [] }], []),
    );
    sendHistory(QUIET_NOTE_AFTER_DAYS);

    const result = await pushDigests();

    expect(result.sent).toBe(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText.mock.calls[0]?.[1]).toBe(quietNote([], []));
    // 补助不是列表：不动「收藏 N」的序号来源。
    expect(dbMock.insertCalls).toHaveLength(0);
    // 记账：空列表也刷新 lastSentAt，避免天天补一句。
    expect(historyMock.recordPush).toHaveBeenCalledWith('alice', [], expect.any(Date));
  });

  it('静默补助点名被屏蔽的语言（沉默不等于坏了）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(
      makeEntry('a/go-one', { language: 'go' }),
      makeEntry('b/go-two', { language: 'go' }),
    );
    tasteMock.loadUserSignalsStrict.mockResolvedValue(
      composeSignals([], [
        { at: new Date().toISOString(), kind: 'dislike', languages: ['go'], topics: [] },
        { at: new Date().toISOString(), kind: 'dislike', languages: ['go'], topics: [] },
      ]),
    );
    sendHistory(4);

    await pushDigests();

    const sent = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(sent).toContain('已按你的「不感兴趣」屏蔽 go');
  });

  it('部署首日（从没发过）→ 全被过滤也不凭空问候', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/flat', { starsDelta: 1 }));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('发送成功后 recordPush 记下实际展示的条目（不只是候选池）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'), makeEntry('b/two'));

    await pushDigests();

    expect(historyMock.recordPush).toHaveBeenCalledWith(
      'alice',
      ['a/one', 'b/two'],
      expect.any(Date),
    );
  });

  it('收藏名大小写不同也不再出现（GitHub 名字大小写不敏感）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('Owner/One'), makeEntry('b/two'));
    tasteMock.loadUserSignalsStrict.mockResolvedValue(
      composeSignals([{ fullName: 'owner/one', language: 'Go', topics: [] }], []),
    );

    const result = await pushDigests();

    expect(result.sent).toBe(1);
    const sent = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(sent).toContain('b/two');
    expect(sent).not.toContain('Owner/One');
  });

  it('GitHub 网页上的 star 也参与过滤（本地没有收藏行）', async () => {
    dbMock.selectRows.push(
      makeSub({ githubLogin: 'alice-gh', githubTokenEnc: 'enc:token' }),
    );
    dbMock.executeRows.push(makeEntry('web/starred'), makeEntry('a/fresh'));
    starMock.loadStarredNames.mockResolvedValue({
      names: ['web/starred'],
      cached: true,
    });

    const result = await pushDigests();

    expect(result.sent).toBe(1);
    const sent = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(sent).toContain('a/fresh');
    expect(sent).not.toContain('web/starred');
  });

  it('未绑定 GitHub 的用户不调用 star 名单（零额外网络）', async () => {
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));

    await pushDigests();

    expect(starMock.loadStarredNames).toHaveBeenCalledWith('alice', null, null, expect.any(Date));
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('画像读不到 → 宁可不发（failed，回滚 claim 等下个整点），绝不发未过滤的简报', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.selectRows.push(makeSub());
    dbMock.executeRows.push(makeEntry('a/one'));
    tasteMock.loadUserSignalsStrict.mockRejectedValue(new Error('db down'));

    const result = await pushDigests();

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    const rollback = dbMock.updateCalls.find((c) => c.kind === 'update');
    expect(rollback?.values).toEqual({ lastDigestAt: null });
    expect(dbMock.insertCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
