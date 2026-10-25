import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 邮箱端点（订阅 / 确认 / 设置 / 退订）的端点级测试：
 * db 打桩（按表分流）、发信与快照打桩，绝不触网。
 */
const dbState = vi.hoisted(() => ({
  emailRows: [] as Array<Record<string, unknown>>,
  kvRows: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ values: Record<string, unknown> }>,
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  insertReturning: [{ id: 7 }],
  /** 条件 UPDATE 的 returning 结果（确认抢占用；空数组模拟抢占落败）。 */
  updateReturning: [{ id: 1 }] as unknown[],
  updateError: null as Error | null,
}));

vi.mock('../src/db/client', async () => {
  const { emailSubscribers, kvCache } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === kvCache
                ? [...dbState.kvRows]
                : table === emailSubscribers
                  ? [...dbState.emailRows]
                  : [],
            ),
        }),
      }),
      insert: (table: unknown) => {
        // kv_cache 的 upsert 要真的落到内存表里：名额退还（失败退号）会先读再写。
        const persist = (values: unknown) => {
          dbState.insertCalls.push({ table, values });
          if (table !== kvCache) return;
          const row = values as { key: string };
          const index = dbState.kvRows.findIndex((entry) => entry.key === row.key);
          if (index >= 0) dbState.kvRows[index] = row;
          else dbState.kvRows.push(row);
        };
        return {
          values: (values: unknown) => ({
            onConflictDoUpdate: () => ({
              returning: async () => {
                persist(values);
                return dbState.insertReturning;
              },
              then: (resolve: (value: unknown) => unknown) => {
                persist(values);
                return Promise.resolve(undefined).then(resolve);
              },
            }),
          }),
        };
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            dbState.updateCalls.push({ values });
            const result = dbState.updateError
              ? Promise.reject(dbState.updateError)
              : Promise.resolve(dbState.updateReturning);
            // 兼容两种用法：普通 await（返回 undefined）与 .returning()（拿抢占结果）。
            return {
              returning: () => result,
              then: (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
                result.then(
                  () => undefined,
                  (err) => {
                    if (reject) return reject(err);
                    throw err;
                  },
                ).then(resolve),
            };
          },
        }),
      }),
    }),
  };
});

const emailState = vi.hoisted(() => ({
  configured: true,
  sendCalls: [] as Array<{
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }>,
  fail: false,
}));

vi.mock('../src/email/send', () => ({
  emailConfigured: () => emailState.configured,
  sendEmail: async (msg: {
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }) => {
    emailState.sendCalls.push(msg);
    if (emailState.fail) throw new Error('resend down');
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
  const actual = await vi.importActual<typeof import('../src/agent/digest-snapshot')>(
    '../src/agent/digest-snapshot',
  );
  return {
    ...actual,
    getDailySnapshot: async () => snapshotState.snapshot,
  };
});

const ENV = vi.hoisted(() => ({
  PUBLIC_BASE_URL: undefined as string | undefined,
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

vi.mock('../src/config', () => ({
  env: ENV,
  SCRAPER_LANGUAGES: ENV.SCRAPER_LANGUAGES,
}));

import confirmHandler from '../api/email-confirm';
import settingsHandler from '../api/email-settings';
import unsubscribeHandler from '../api/email-unsubscribe';
import subscribeHandler from '../api/subscribe';
import { shanghaiToday } from '../src/agent/time';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  status(code: number): MockRes;
  setHeader(name: string, value: string): MockRes;
  send(body: string): MockRes;
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
  };
}

const HEADERS = { host: 'agent.example.com' };

function emailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: 'reader@example.com',
    confirmToken: 'confirm-token',
    unsubToken: 'unsub-token',
    confirmed: false,
    active: true,
    preferences: {
      pushTime: '09:00',
      intervalDays: 1,
      digestCount: 15,
      languages: [],
      keywords: [],
    },
    lastSentAt: null,
    confirmSentAt: new Date(),
    consecutiveFailures: 0,
    createdAt: new Date(),
    confirmedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.emailRows = [];
  dbState.kvRows = [];
  dbState.updateCalls = [];
  dbState.insertCalls = [];
  dbState.insertReturning = [{ id: 7 }];
  dbState.updateReturning = [{ id: 1 }];
  dbState.updateError = null;
  emailState.configured = true;
  emailState.sendCalls = [];
  emailState.fail = false;
  snapshotState.snapshot = null;
  ENV.PUBLIC_BASE_URL = undefined;
});

// ---------------------------------------------------------------------------
// /api/subscribe
// ---------------------------------------------------------------------------

describe('POST /api/subscribe', () => {
  it('serves the form on GET', async () => {
    const res = mockRes();
    await subscribeHandler({ method: 'GET' } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="/api/subscribe"');
    expect(res.body).toContain('name="email"');
  });

  it('returns 503 when the email channel is not configured', async () => {
    emailState.configured = false;
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: 'email=a@b.co', headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(503);
    expect(emailState.sendCalls).toHaveLength(0);
    expect(dbState.insertCalls).toHaveLength(0);
  });

  it('rejects an invalid address without touching the database', async () => {
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'not-an-email' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(dbState.insertCalls).toHaveLength(0);
    expect(emailState.sendCalls).toHaveLength(0);
  });

  it('accepts urlencoded string, Buffer and parsed-object bodies alike', async () => {
    for (const body of [
      'email=Reader%40Example.com',
      Buffer.from('email=Reader%40Example.com'),
      { email: 'Reader@Example.com' },
    ]) {
      dbState.emailRows = [];
      dbState.kvRows = [];
      dbState.insertCalls = [];
      emailState.sendCalls = [];
      const res = mockRes();
      await subscribeHandler({ method: 'POST', body, headers: HEADERS } as never, res as never);
      expect(res.statusCode).toBe(200);
      // 响应统一为中性文案：不因邮箱是否已存在而不同（避免订阅状态枚举）。
      expect(res.body).toContain('如果这个邮箱可以订阅');
      expect(emailState.sendCalls).toHaveLength(1);
      // 邮箱去空白、小写化后写入与发信。
      expect(emailState.sendCalls[0].to).toBe('reader@example.com');
      // 确认信冷却计数会先写一行 kv_cache，所以按 email 字段挑出订阅者插入。
      const subscriberInsert = dbState.insertCalls.find((call) =>
        Object.prototype.hasOwnProperty.call(call.values as object, 'email'),
      );
      const inserted = subscriberInsert?.values as {
        email: string;
        confirmToken: string;
        confirmSentAt: Date;
      };
      expect(inserted.email).toBe('reader@example.com');
      expect(inserted.confirmToken).toEqual(expect.any(String));
      expect(inserted.confirmSentAt).toBeInstanceOf(Date);
    }
  });

  it('sends a confirmation link with the 48h notice and a settings-free body', async () => {
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      res as never,
    );
    const sent = emailState.sendCalls[0];
    expect(sent.subject).toBe('确认订阅 GitHub 热榜简报');
    expect(sent.text).toContain('链接 48 小时内有效');
    expect(sent.text).toMatch(
      /https:\/\/agent\.example\.com\/api\/email-confirm\?t=[A-Za-z0-9]+/,
    );
  });

  it('never puts a subscriber’s settings token in the response', async () => {
    // 公开端点：任何人提交一个已订阅邮箱都不能拿到对方的 unsubToken。
    dbState.emailRows = [
      emailRow({ confirmed: true, confirmSentAt: new Date(Date.now() - 60 * 60 * 1000) }),
    ];
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('unsub-token');
    expect(res.body).not.toContain('/api/email-settings');
    // 管理链接只发到邮箱本人（同一邮件的收件人只能是该地址）。
    expect(emailState.sendCalls).toHaveLength(1);
    expect(emailState.sendCalls[0].to).toBe('reader@example.com');
    expect(emailState.sendCalls[0].html).toContain(
      'https://agent.example.com/api/email-settings?t=unsub-token',
    );
    expect(emailState.sendCalls[0].html).toContain(
      'https://agent.example.com/api/email-unsubscribe?t=unsub-token',
    );
    // 不改任何订阅状态：唯一允许的写入是冷却锚点（confirmSentAt），
    // 绝不碰 active / confirmToken / unsubToken。
    for (const call of dbState.updateCalls) {
      expect(call.values).not.toHaveProperty('active');
      expect(call.values).not.toHaveProperty('confirmToken');
      expect(call.values).not.toHaveProperty('unsubToken');
      expect(call.values.confirmSentAt).toBeInstanceOf(Date);
    }
  });

  it('sends the same neutral reply to a known and an unknown address', async () => {
    const known = mockRes();
    dbState.emailRows = [
      emailRow({ confirmed: true, confirmSentAt: new Date(Date.now() - 60 * 60 * 1000) }),
    ];
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      known as never,
    );
    const unknown = mockRes();
    dbState.emailRows = [];
    dbState.insertCalls = [];
    emailState.sendCalls = [];
    await subscribeHandler(
      { method: 'POST', body: { email: 'nobody@example.com' }, headers: HEADERS } as never,
      unknown as never,
    );
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
  });

  it('does not reactivate an unsubscribed address from a third-party submission', async () => {
    // 退订只能由本人点击恢复链接撤销，不能因为别人提交了这个邮箱就重新开始发信。
    dbState.emailRows = [
      emailRow({
        confirmed: true,
        active: false,
        confirmToken: null,
        confirmSentAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    ];
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('unsub-token');
    // 不得出现「直接置 active=true」的写入。
    expect(dbState.updateCalls.some((call) => call.values.active === true)).toBe(false);
    // 恢复订阅必须经过一次确认：发一封带一次性 confirmToken 的恢复邮件。
    expect(emailState.sendCalls).toHaveLength(1);
    expect(emailState.sendCalls[0].to).toBe('reader@example.com');
    expect(emailState.sendCalls[0].text).toMatch(
      /https:\/\/agent\.example\.com\/api\/email-confirm\?t=[A-Za-z0-9]+/,
    );
    const tokenWrite = dbState.updateCalls.find(
      (call) => typeof call.values.confirmToken === 'string',
    );
    expect(tokenWrite).toBeDefined();
    expect(tokenWrite?.values.confirmSentAt).toBeInstanceOf(Date);
  });

  it('honours the 10-minute cooldown without revealing subscription state', async () => {
    dbState.emailRows = [
      emailRow({ confirmSentAt: new Date(Date.now() - 5 * 60 * 1000) }),
    ];
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('如果这个邮箱可以订阅');
    expect(emailState.sendCalls).toHaveLength(0);
  });

  it('stops at the global daily confirmation cap', async () => {
    dbState.kvRows = [
      {
        key: 'email_confirm_sent:2026-10-25',
        value: { count: 50 },
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(429);
    expect(emailState.sendCalls).toHaveLength(0);
  });

  it('rolls back the token and the daily slot when the confirmation mail fails', async () => {
    emailState.fail = true;
    const res = mockRes();
    await subscribeHandler(
      { method: 'POST', body: { email: 'reader@example.com' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(502);
    expect(dbState.updateCalls[0].values).toEqual({
      confirmToken: null,
      confirmSentAt: null,
    });
    // 发信失败不能永久占用「每日 50 封确认信」的名额：取号 +1 后要退号 -1。
    const slotKey = `email_confirm_sent:${shanghaiToday()}`;
    const slotWrites = dbState.insertCalls
      .map((call) => call.values as { key?: string; value?: { count?: number } })
      .filter((values) => values.key === slotKey)
      .map((values) => values.value?.count);
    expect(slotWrites).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// /api/email-confirm
// ---------------------------------------------------------------------------

describe('GET /api/email-confirm', () => {
  it('rejects a missing token with 400 and zero writes', async () => {
    const res = mockRes();
    await confirmHandler({ method: 'GET', query: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('returns 404 for an unknown token without writing', async () => {
    const res = mockRes();
    await confirmHandler(
      { method: 'GET', query: { t: 'nope' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect(dbState.updateCalls).toHaveLength(0);
    expect(emailState.sendCalls).toHaveLength(0);
  });

  it('rejects a token older than 48 hours without writing', async () => {
    dbState.emailRows = [
      emailRow({ confirmSentAt: new Date(Date.now() - 49 * 60 * 60 * 1000) }),
    ];
    const res = mockRes();
    await confirmHandler(
      { method: 'GET', query: { t: 'confirm-token' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('确认链接已过期');
    expect(dbState.updateCalls).toHaveLength(0);
    expect(emailState.sendCalls).toHaveLength(0);
  });

  it('confirms and immediately sends today’s digest with unsubscribe headers', async () => {
    dbState.emailRows = [emailRow()];
    snapshotState.snapshot = {
      date: '2026-10-25',
      dataDate: '2026-10-25',
      abstract: '今天的主题。',
      items: [
        {
          fullName: 'a/one',
          description: null,
          topics: [],
          language: 'typescript',
          stars: 1,
          starsDelta: 2,
          isNew: false,
          htmlUrl: 'https://github.com/a/one',
          summary: '第一个项目。',
        },
      ],
    };

    const res = mockRes();
    await confirmHandler(
      { method: 'GET', query: { t: 'confirm-token' }, headers: HEADERS } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('今日简报已发到你的邮箱');
    // 首次 update：确认状态；第二次：lastSentAt 锚到北京当日 00:00。
    expect(dbState.updateCalls[0].values).toMatchObject({
      confirmed: true,
      active: true,
      confirmToken: null,
    });
    expect(dbState.updateCalls[1].values).toHaveProperty('lastSentAt');
    expect(emailState.sendCalls).toHaveLength(1);
    expect(emailState.sendCalls[0].to).toBe('reader@example.com');
    expect(emailState.sendCalls[0].subject).toBe('GitHub 热榜简报 · 10-25');
    expect(emailState.sendCalls[0].headers).toEqual({
      'List-Unsubscribe': '<https://agent.example.com/api/email-unsubscribe?t=unsub-token>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('confirms exactly once when the same link is opened twice concurrently', async () => {
    // 抢占落败：条件 UPDATE（WHERE confirm_token = $1）没有返回行，说明已被另一个请求用掉。
    dbState.emailRows = [emailRow()];
    dbState.updateReturning = [];
    const res = mockRes();
    await confirmHandler(
      { method: 'GET', query: { t: 'confirm-token' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('链接无效或已使用');
    expect(emailState.sendCalls).toHaveLength(0);
  });

  it('still confirms when the snapshot is unavailable', async () => {
    dbState.emailRows = [emailRow()];
    snapshotState.snapshot = null;
    const res = mockRes();
    await confirmHandler(
      { method: 'GET', query: { t: 'confirm-token' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('下次推送时间');
    expect(emailState.sendCalls).toHaveLength(0);
    // 只写确认状态，不写 lastSentAt（否则今天会漏发）。
    expect(dbState.updateCalls).toHaveLength(1);
  });

  it('still confirms when the immediate send fails', async () => {
    dbState.emailRows = [emailRow()];
    snapshotState.snapshot = {
      date: '2026-10-25',
      dataDate: '2026-10-25',
      abstract: null,
      items: [
        {
          fullName: 'a/one',
          description: null,
          topics: [],
          language: null,
          stars: 1,
          starsDelta: 1,
          isNew: false,
          htmlUrl: 'https://github.com/a/one',
        },
      ],
    };
    emailState.fail = true;
    const res = mockRes();
    await confirmHandler(
      { method: 'GET', query: { t: 'confirm-token' }, headers: HEADERS } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('下次推送时间');
    expect(dbState.updateCalls).toHaveLength(1);
    expect(dbState.updateCalls[0].values).toMatchObject({ confirmed: true });
  });
});

// ---------------------------------------------------------------------------
// /api/email-settings
// ---------------------------------------------------------------------------

describe('/api/email-settings', () => {
  it('rejects a missing token with 400', async () => {
    const res = mockRes();
    await settingsHandler({ method: 'GET', query: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown token with zero writes', async () => {
    const res = mockRes();
    await settingsHandler({ method: 'GET', query: { t: 'nope' } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('renders the form with the current preferences', async () => {
    dbState.emailRows = [
      emailRow({
        preferences: {
          pushTime: '11:00',
          intervalDays: 2,
          digestCount: 20,
          languages: ['rust'],
          keywords: ['ai'],
        },
      }),
    ];
    const res = mockRes();
    await settingsHandler(
      { method: 'GET', query: { t: 'unsub-token' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="11:00" selected');
    expect(res.body).toContain('value="2" selected');
    expect(res.body).toContain('value="20" selected');
    expect(res.body).toContain('value="rust" checked');
    expect(res.body).toContain('value="ai"');
  });

  it('rejects an out-of-window push time without writing', async () => {
    dbState.emailRows = [emailRow()];
    const res = mockRes();
    await settingsHandler(
      {
        method: 'POST',
        query: { t: 'unsub-token' },
        body: { pushTime: '08:00', intervalDays: '1', digestCount: '15' },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('09:00–17:00');
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('rejects invalid intervals and counts without writing', async () => {
    dbState.emailRows = [emailRow()];
    for (const body of [
      { pushTime: '09:00', intervalDays: '4', digestCount: '15' },
      { pushTime: '09:00', intervalDays: '1', digestCount: '7' },
    ]) {
      const res = mockRes();
      await settingsHandler(
        { method: 'POST', query: { t: 'unsub-token' }, body } as never,
        res as never,
      );
      expect(res.statusCode).toBe(400);
    }
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('saves valid preferences including every checked language', async () => {
    dbState.emailRows = [emailRow()];
    const res = mockRes();
    await settingsHandler(
      {
        method: 'POST',
        query: { t: 'unsub-token' },
        body: {
          pushTime: '17:00',
          intervalDays: '3',
          digestCount: '5',
          languages: ['python', 'rust', 'brainfuck'],
          keywords: 'AI！, 开发效率 ,ai',
        },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('设置已保存');
    expect(dbState.updateCalls[0].values).toEqual({
      preferences: {
        pushTime: '17:00',
        intervalDays: 3,
        digestCount: 5,
        languages: ['python', 'rust'],
        keywords: ['ai', '开发效率'],
      },
    });
  });

  it('keeps repeated urlencoded language fields', async () => {
    dbState.emailRows = [emailRow()];
    const res = mockRes();
    await settingsHandler(
      {
        method: 'POST',
        query: { t: 'unsub-token' },
        body: 'pushTime=10:00&intervalDays=1&digestCount=10&languages=go&languages=rust',
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const preferences = (dbState.updateCalls[0].values as { preferences: { languages: string[] } })
      .preferences;
    expect(preferences.languages).toEqual(['go', 'rust']);
  });
});

// ---------------------------------------------------------------------------
// /api/email-unsubscribe
// ---------------------------------------------------------------------------

describe('/api/email-unsubscribe', () => {
  it('returns 404 for an unknown token', async () => {
    const res = mockRes();
    await unsubscribeHandler({ method: 'GET', query: { t: 'nope' } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('deactivates an active subscriber', async () => {
    dbState.emailRows = [emailRow()];
    const res = mockRes();
    await unsubscribeHandler(
      { method: 'GET', query: { t: 'unsub-token' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('已不再收到');
    expect(dbState.updateCalls[0].values).toEqual({ active: false });
  });

  it('is idempotent for an already-inactive subscriber', async () => {
    dbState.emailRows = [emailRow({ active: false })];
    const res = mockRes();
    await unsubscribeHandler(
      { method: 'GET', query: { t: 'unsub-token' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('answers RFC 8058 one-click POST with 200 OK even for unknown tokens', async () => {
    const res = mockRes();
    await unsubscribeHandler(
      { method: 'POST', query: { t: 'nope' }, body: 'List-Unsubscribe=One-Click' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('returns 500 when a one-click POST cannot be persisted', async () => {
    // 报成 200 会让邮件服务商认为退订已完成、不再重试，而用户会继续收到简报。
    dbState.emailRows = [emailRow()];
    dbState.updateError = new Error('db down');
    const res = mockRes();
    await unsubscribeHandler(
      {
        method: 'POST',
        query: { t: 'unsub-token' },
        body: 'List-Unsubscribe=One-Click',
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toBe('OK');
  });

  it('deactivates on one-click POST', async () => {
    dbState.emailRows = [emailRow()];
    const res = mockRes();
    await unsubscribeHandler(
      {
        method: 'POST',
        query: { t: 'unsub-token' },
        body: 'List-Unsubscribe=One-Click',
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(dbState.updateCalls[0].values).toEqual({ active: false });
  });
});
