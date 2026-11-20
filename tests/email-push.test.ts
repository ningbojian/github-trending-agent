import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 邮件推送：db / 发信 / 快照打桩；选择层与模板使用真实实现，绝不触网。 */
const dbState = vi.hoisted(() => ({
  emailRows: [] as Array<Record<string, unknown>>,
  kvRows: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ values: Record<string, unknown>; kind: 'claim' | 'update' }>,
  claimResults: [] as Array<Array<Record<string, unknown>>>,
  insertCalls: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock('../src/db/client', async () => {
  const { emailSubscribers, kvCache } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === emailSubscribers
                ? [...dbState.emailRows]
                : table === kvCache
                  ? [...dbState.kvRows]
                  : [],
            ),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            return {
              returning: async () => {
                dbState.updateCalls.push({ values, kind: 'claim' });
                return dbState.claimResults.length > 0
                  ? (dbState.claimResults.shift() as Array<Record<string, unknown>>)
                  : [{ id: 1 }];
              },
              then: (
                onFulfilled?: (value: void) => unknown,
                onRejected?: (reason: unknown) => unknown,
              ) => {
                dbState.updateCalls.push({ values, kind: 'update' });
                return Promise.resolve(undefined).then(onFulfilled, onRejected);
              },
            };
          },
        }),
      }),
      insert: () => ({
        values: (values: { key: string; value: unknown }) => {
          dbState.insertCalls.push(values);
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    }),
  };
});

const poolMock = vi.hoisted(() => ({
  readLatestOpportunityPool: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../src/opportunities/pool', () => ({
  readLatestOpportunityPool: poolMock.readLatestOpportunityPool,
}));

const oppStoreMock = vi.hoisted(() => ({
  readShownOpportunities: vi.fn(async () => new Set<string>()),
  markOpportunitiesShown: vi.fn(async () => undefined),
}));
vi.mock('../src/opportunities/store', () => ({
  readShownOpportunities: oppStoreMock.readShownOpportunities,
  markOpportunitiesShown: oppStoreMock.markOpportunitiesShown,
}));

const mailState = vi.hoisted(() => ({
  configured: true,  sendCalls: [] as Array<{
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }>,
  failFor: new Set<string>(),
}));

vi.mock('../src/email/send', () => ({
  emailConfigured: () => mailState.configured,
  sendEmail: async (msg: {
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }) => {
    mailState.sendCalls.push(msg);
    if (mailState.failFor.has(msg.to)) throw new Error('resend down');
  },
}));

const snapshotState = vi.hoisted(() => ({
  snapshot: null as null | {
    date: string;
    dataDate: string | null;
    abstract: string | null;
    items: Array<Record<string, unknown>>;
  },
}));

vi.mock('../src/agent/digest-snapshot', async () => {
  const actual = await vi.importActual<
    typeof import('../src/agent/digest-snapshot')
  >('../src/agent/digest-snapshot');
  return {
    ...actual,
    getDailySnapshot: async () => snapshotState.snapshot,
  };
});

vi.mock('../src/config', () => ({
  env: { PUBLIC_BASE_URL: 'https://agent.example.com' },
  SCRAPER_LANGUAGES: [
    'python',
    'typescript',
    'javascript',
    'go',
    'rust',
    'java',
    'c',
    'c++',
    'c#',
    'php',
    'ruby',
    'swift',
    'kotlin',
    'dart',
    'shell',
    'html',
    'css',
    'vue',
    'lua',
  ],
}));

import { pushEmailDigests } from '../src/email/push';

/** 北京时间 09:30。 */
const NOW = new Date('2026-10-25T01:30:00Z');

function snapItem(fullName: string, language: string) {
  return {
    fullName,
    description: null,
    topics: [],
    language,
    stars: 100,
    starsDelta: 10,
    isNew: false,
    htmlUrl: `https://github.com/${fullName}`,
    summary: `${fullName} 的中文简介。`,
  };
}

function emailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: 'reader@example.com',
    confirmToken: null,
    unsubToken: 'unsub-token',
    confirmed: true,
    active: true,
    preferences: {
      pushTime: '09:00',
      intervalDays: 1,
      digestCount: 15,
      languages: [],
      keywords: [],
    },
    lastSentAt: null,
    confirmSentAt: null,
    consecutiveFailures: 0,
    createdAt: new Date(),
    confirmedAt: new Date(),
    ...overrides,
  };
}

const OPPORTUNITY = {
  id: 'contribute:acme/agent#12',
  kind: 'contribute',
  repo: 'acme/agent',
  issueNumber: 12,
  title: 'Windows 下 CUDA 检测失败',
  body: '...',
  url: 'https://github.com/acme/agent/issues/12',
  language: 'typescript',
  topics: ['agent'],
  stars: 500,
  license: 'MIT',
  archived: false,
  pushedAt: '2026-11-10T00:00:00.000Z',
  labels: ['good first issue'],
  comments: 3,
  reactions: 2,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
  maintainerEngaged: true,
  assigned: false,
  linkedPr: false,
  score: 80,
  why: '值得修。',
  firstStep: '复现并认领。',
  effort: '小',
  confidence: '高',
  evidence: [],
};

function poolOf(items: unknown[]) {
  return {
    version: 1,
    date: '2026-10-25',
    dataDate: '2026-10-25',
    generatedAt: '2026-10-25T00:00:00.000Z',
    items,
  };
}

beforeEach(() => {
  dbState.emailRows = [];
  dbState.kvRows = [];
  dbState.updateCalls = [];
  dbState.claimResults = [];
  dbState.insertCalls = [];
  mailState.configured = true;
  mailState.sendCalls = [];
  poolMock.readLatestOpportunityPool.mockReset();
  poolMock.readLatestOpportunityPool.mockResolvedValue(null);
  oppStoreMock.readShownOpportunities.mockReset();
  oppStoreMock.readShownOpportunities.mockResolvedValue(new Set());
  oppStoreMock.markOpportunitiesShown.mockReset();
  oppStoreMock.markOpportunitiesShown.mockResolvedValue(undefined);
  mailState.failFor = new Set();
  snapshotState.snapshot = {
    date: '2026-10-25',
    dataDate: '2026-10-25',
    abstract: '今天的主题。',
    items: [snapItem('a/rust-one', 'rust'), snapItem('b/ts-one', 'typescript')],
  };
});

describe('pushEmailDigests — base url', () => {
  it('uses the caller-supplied base URL (cron has no request headers)', async () => {
    // cron 路径拿不到 Host：不显式传入就会把链接写成 localhost，用户点不开。
    dbState.emailRows = [emailRow()];
    const result = await pushEmailDigests({
      now: NOW,
      gapMs: 0,
      baseUrl: 'https://digest.example.com',
    });

    expect(result.sent).toBe(1);
    const sent = mailState.sendCalls[0];
    expect(sent.html).toContain(
      'https://digest.example.com/api/email-settings?t=unsub-token',
    );
    expect(sent.headers?.['List-Unsubscribe']).toBe(
      '<https://digest.example.com/api/email-unsubscribe?t=unsub-token>',
    );
  });
});

describe('pushEmailDigests — gates', () => {
  it('is a no-op when the email channel is not configured', async () => {
    mailState.configured = false;
    dbState.emailRows = [emailRow()];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(0);
  });

  it('skips outside the 09:00–18:00 Beijing window', async () => {
    dbState.emailRows = [emailRow()];
    // 08:00 北京时间。
    const result = await pushEmailDigests({
      now: new Date('2026-10-25T00:00:00Z'),
      gapMs: 0,
    });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(dbState.updateCalls).toHaveLength(0);
    expect(mailState.sendCalls).toHaveLength(0);
  });

  it('skips at or after 18:00 Beijing time', async () => {
    dbState.emailRows = [emailRow()];
    const result = await pushEmailDigests({
      now: new Date('2026-10-25T10:00:00Z'),
      gapMs: 0,
    });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('honours each subscriber’s integer push time', async () => {
    dbState.emailRows = [
      emailRow({
        preferences: {
          pushTime: '10:00',
          intervalDays: 1,
          digestCount: 15,
          languages: [],
          keywords: [],
        },
      }),
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(0);
  });

  it('skips when today’s digest was already sent', async () => {
    dbState.emailRows = [
      emailRow({ lastSentAt: new Date('2026-10-25T00:00:00Z') }), // 北京当日 08:00
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('sends the next morning even when yesterday’s push was late (calendar days, not 24h)', async () => {
    dbState.emailRows = [
      emailRow({
        // 昨天 21:00（北京）发过 → 今天 09:30 只隔 12.5 小时，仍应发。
        // 精确 24 小时会让这次被跳过，之后每天的发送时间再也不会回到 09:00。
        lastSentAt: new Date('2026-10-24T13:00:00Z'),
      }),
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(1);
  });

  it('skips until the interval has elapsed', async () => {
    dbState.emailRows = [
      emailRow({
        // 昨天 09:00（北京）已发；每 2 天 → 今天不发。
        lastSentAt: new Date('2026-10-24T01:00:00Z'),
        preferences: {
          pushTime: '09:00',
          intervalDays: 2,
          digestCount: 15,
          languages: [],
          keywords: [],
        },
      }),
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(0);
  });

  it('sends again once the interval has elapsed', async () => {
    dbState.emailRows = [
      emailRow({
        lastSentAt: new Date('2026-10-23T00:30:00Z'), // 两天多以前
        preferences: {
          pushTime: '09:00',
          intervalDays: 2,
          digestCount: 15,
          languages: [],
          keywords: [],
        },
      }),
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it('skips the whole round when the snapshot is unavailable', async () => {
    dbState.emailRows = [emailRow()];
    snapshotState.snapshot = null;
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('counts a lost claim race as skipped, not failed', async () => {
    dbState.emailRows = [emailRow()];
    dbState.claimResults = [[]];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(0);
  });
});

describe('pushEmailDigests — sending', () => {
  it('claims, sends one email with list-unsubscribe headers and counts it', async () => {
    dbState.emailRows = [emailRow()];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(dbState.updateCalls[0]).toMatchObject({ kind: 'claim' });
    expect(mailState.sendCalls).toHaveLength(1);
    const sent = mailState.sendCalls[0];
    expect(sent.to).toBe('reader@example.com');
    expect(sent.subject).toBe('GitHub 热榜简报 · 10-25');
    expect(sent.text).toContain('a/rust-one');
    expect(sent.headers).toEqual({
      'List-Unsubscribe':
        '<https://agent.example.com/api/email-unsubscribe?t=unsub-token>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    // 全局日计数写入 kv_cache（现在还会先写一条推送历史，按 key 找计数那条）。
    const daily = dbState.insertCalls.find((call) =>
      String(call.key).startsWith('email_digest_sent'),
    );
    expect(daily?.key).toBe('email_digest_sent:2026-10-25');
    expect(daily?.value).toEqual({ count: 1 });
  });

  it('selects entries per subscriber（语言过滤 + 条数）', async () => {
    snapshotState.snapshot = {
      date: '2026-10-25',
      dataDate: '2026-10-25',
      abstract: null,
      items: [
        snapItem('a/rust-one', 'rust'),
        snapItem('b/ts-one', 'typescript'),
        snapItem('c/rust-two', 'rust'),
      ],
    };
    dbState.emailRows = [
      emailRow({
        id: 1,
        email: 'rust@example.com',
        preferences: {
          pushTime: '09:00',
          intervalDays: 1,
          digestCount: 5,
          languages: ['rust'],
          keywords: [],
        },
      }),
      emailRow({
        id: 2,
        email: 'ts@example.com',
        unsubToken: 'tok-2',
        preferences: {
          pushTime: '09:00',
          intervalDays: 1,
          digestCount: 5,
          languages: ['typescript'],
          keywords: [],
        },
      }),
    ];

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 2, skipped: 0, failed: 0 });
    const [rustMail, tsMail] = mailState.sendCalls;
    expect(rustMail.text).toContain('a/rust-one');
    expect(rustMail.text).toContain('c/rust-two');
    expect(rustMail.text).not.toContain('b/ts-one');
    expect(tsMail.text).toContain('b/ts-one');
    expect(tsMail.text).not.toContain('a/rust-one');
  });

  it('rolls back lastSentAt without a failure count when nothing matches', async () => {
    dbState.emailRows = [
      emailRow({
        lastSentAt: null,
        preferences: {
          pushTime: '09:00',
          intervalDays: 1,
          digestCount: 15,
          languages: ['go'],
          keywords: [],
        },
      }),
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(dbState.updateCalls[1]).toMatchObject({
      kind: 'update',
      values: { lastSentAt: null },
    });
    expect(dbState.updateCalls[1].values).not.toHaveProperty('consecutiveFailures');
    expect(mailState.sendCalls).toHaveLength(0);
  });

  it('resets consecutive failures after a successful send', async () => {
    dbState.emailRows = [emailRow({ consecutiveFailures: 2 })];
    await pushEmailDigests({ now: NOW, gapMs: 0 });
    const reset = dbState.updateCalls.find(
      (call) => call.kind === 'update' && call.values.consecutiveFailures === 0,
    );
    expect(reset).toBeDefined();
  });

  it('does not write a reset when there were no failures', async () => {
    dbState.emailRows = [emailRow({ consecutiveFailures: 0 })];
    await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(
      dbState.updateCalls.filter((call) => call.kind === 'update'),
    ).toHaveLength(0);
  });

  it('rolls back, counts the failure and increments consecutiveFailures', async () => {
    dbState.emailRows = [emailRow({ consecutiveFailures: 1 })];
    mailState.failFor.add('reader@example.com');

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(dbState.updateCalls[1]).toMatchObject({
      kind: 'update',
      values: { lastSentAt: null, consecutiveFailures: 2 },
    });
    expect(dbState.updateCalls[1].values).not.toHaveProperty('active', false);
  });

  it('deactivates after the fifth consecutive failure', async () => {
    dbState.emailRows = [emailRow({ consecutiveFailures: 4 })];
    mailState.failFor.add('reader@example.com');

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(dbState.updateCalls[1].values).toMatchObject({
      consecutiveFailures: 5,
      active: false,
    });
  });

  it('stops at the daily cap and leaves the rest for the next tick', async () => {
    dbState.emailRows = [
      emailRow({ id: 1, email: 'one@example.com' }),
      emailRow({ id: 2, email: 'two@example.com', unsubToken: 'tok-2' }),
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0, dailyCap: 1 });

    expect(result).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(1);
  });

  it('caps a single run at 50 sends and leaves the rest for the next tick', async () => {
    // 单轮封顶：一次函数调用最多 50 封，避免长耗时与免费额度被打爆；
    // 未发者不写 lastSentAt，下一个整点自然重试。
    dbState.emailRows = Array.from({ length: 55 }, (_, index) =>
      emailRow({
        id: index + 1,
        email: `user${index}@example.com`,
        unsubToken: `tok-${index}`,
      }),
    );
    const result = await pushEmailDigests({ now: NOW, gapMs: 0, dailyCap: 300 });

    expect(result).toEqual({ sent: 50, skipped: 5, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(50);
  });

  it('subtracts already-sent mails from the daily cap', async () => {
    dbState.emailRows = [emailRow()];
    dbState.kvRows = [
      {
        key: 'email_digest_sent:2026-10-25',
        value: { count: 300 },
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('每天且开启偏好 → 简报带今日机会，发送后按 email 身份标记', async () => {
    dbState.emailRows = [emailRow()];
    poolMock.readLatestOpportunityPool.mockResolvedValue(poolOf([OPPORTUNITY]));

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result.sent).toBe(1);
    const sent = mailState.sendCalls[0]!;
    expect(sent.html).toContain('今日机会');
    expect(sent.html).not.toContain('本周机会');
    expect(sent.text).toContain('今日机会');
    expect(poolMock.readLatestOpportunityPool).toHaveBeenCalledTimes(1);
    expect(oppStoreMock.readShownOpportunities).toHaveBeenCalledWith(
      'email:1',
      7 * 24 * 60 * 60 * 1000,
    );
    expect(oppStoreMock.markOpportunitiesShown).toHaveBeenCalledWith(
      'email:1',
      ['acme/agent#12'],
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('偏好关闭 → 不读池、不带今日机会', async () => {
    dbState.emailRows = [
      emailRow({
        preferences: {
          pushTime: '09:00',
          intervalDays: 1,
          digestCount: 15,
          languages: [],
          keywords: [],
          weeklyOpportunities: false,
        },
      }),
    ];
    poolMock.readLatestOpportunityPool.mockResolvedValue(poolOf([OPPORTUNITY]));

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result.sent).toBe(1);
    expect(mailState.sendCalls[0]!.html).not.toContain('今日机会');
    expect(poolMock.readLatestOpportunityPool).not.toHaveBeenCalled();
    expect(oppStoreMock.readShownOpportunities).not.toHaveBeenCalled();
    expect(oppStoreMock.markOpportunitiesShown).not.toHaveBeenCalled();
  });

  it('全部已展示 → 只发 trending，不标记', async () => {
    dbState.emailRows = [emailRow()];
    poolMock.readLatestOpportunityPool.mockResolvedValue(poolOf([OPPORTUNITY]));
    oppStoreMock.readShownOpportunities.mockResolvedValue(
      new Set(['acme/agent#12']),
    );

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result.sent).toBe(1);
    expect(mailState.sendCalls[0]!.html).not.toContain('今日机会');
    expect(oppStoreMock.markOpportunitiesShown).not.toHaveBeenCalled();
  });

  it('发送失败不标记机会', async () => {
    dbState.emailRows = [emailRow()];
    poolMock.readLatestOpportunityPool.mockResolvedValue(poolOf([OPPORTUNITY]));
    mailState.failFor.add('reader@example.com');

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result.failed).toBe(1);
    expect(oppStoreMock.markOpportunitiesShown).not.toHaveBeenCalled();
  });

  it('标记失败不影响已发送的邮件', async () => {
    dbState.emailRows = [emailRow()];
    poolMock.readLatestOpportunityPool.mockResolvedValue(poolOf([OPPORTUNITY]));
    oppStoreMock.markOpportunitiesShown.mockRejectedValueOnce(
      new Error('db down'),
    );

    const result = await pushEmailDigests({ now: NOW, gapMs: 0 });

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(mailState.sendCalls).toHaveLength(1);
  });
});
