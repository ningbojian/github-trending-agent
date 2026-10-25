import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, {
  type OAuthRequest,
  type OAuthResponse,
} from '../api/oauth-github';

/**
 * env 惰性单例策略：本文件用 vi.mock 固定 src/config（而非设 process.env），
 * 避免 Proxy 缓存跨文件串味。凭据为单元测试专用假值（非真实密钥）。
 */
const ENV = vi.hoisted(() => ({
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  GITHUB_OAUTH_REDIRECT_URI: 'https://agent.example.com/api/oauth-github',
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key',
}));

vi.mock('../src/config', () => ({ env: ENV }));

/**
 * db mock（供回调端点更新 subscribers 行 + OAuth state 的 kv_cache 读写删）。
 * 桩沿用 digest.test.ts 的宽松风格：只记录调用，不拟合 drizzle 内部类型。
 * delete().where() 会把 kvSelectRows 首行弹出（模拟 state 行被一次性消费）。
 */
const dbState = vi.hoisted(() => ({
  kvSelectRows: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  kvSelectCalls: [] as unknown[],
  kvInsertCalls: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  kvDeleteCalls: [] as unknown[],
  updateCalls: [] as Array<{
    values: Record<string, unknown>;
    condition: unknown;
  }>,
  updateRows: [] as Array<{ id: number }>,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          dbState.kvSelectCalls.push(condition);
          return Promise.resolve([...dbState.kvSelectRows]);
        },
      }),
    }),
    insert: () => ({
      values: (values: { key: string; value: unknown; expiresAt: Date }) => {
        dbState.kvInsertCalls.push(values);
        return Promise.resolve();
      },
    }),
    delete: () => ({
      where: (condition: unknown) => {
        dbState.kvDeleteCalls.push(condition);
        // 一次性消费：真实库中 DELETE 已删除该 key 行，mock 同步弹出首行。
        dbState.kvSelectRows.shift();
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            dbState.updateCalls.push({ values, condition });
            return dbState.updateRows;
          },
        }),
      }),
    }),
  }),
}));

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  // router 现在会加载 ./welcome.js，而 welcome 从 api 里取 sendWeComMarkdown；
  // mock 工厂必须提供该导出，否则 ESM 绑定期报「No export is defined on the mock」。
  sendWeComMarkdown: vi.fn(),
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
  sendWeComMarkdown: apiMock.sendWeComMarkdown,
}));

import {
  bindHandler,
  buildAuthorizeUrl,
  decryptSecret,
  encryptSecret,
  exchangeCode,
} from '../src/github/oauth';
import { registerHandlers, routeMessage, type InboundMessage } from '../src/wecom/router';

// ---------------------------------------------------------------------------
// fetch 桩：绝不触网。
// ---------------------------------------------------------------------------

type FetchStep =
  | Error
  | { ok: boolean; status: number; json?: unknown };

/** 按顺序应答的 fetch mock（Error → 网络错误 reject；其余 → resolve Response 形态）。 */
function stubFetch(steps: FetchStep[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const step of steps) {
    if (step instanceof Error) {
      fetchMock.mockRejectedValueOnce(step);
    } else {
      fetchMock.mockResolvedValueOnce({
        ok: step.ok,
        status: step.status,
        json: async () => step.json,
      });
    }
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 成功的 GitHub 换 token + 拉 user 两连击。 */
const SUCCESS_STEPS: FetchStep[] = [
  {
    ok: true,
    status: 200,
    json: { access_token: 'gho_secret_token', token_type: 'bearer', scope: 'public_repo' },
  },
  { ok: true, status: 200, json: { login: 'alice-gh' } },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// buildAuthorizeUrl（state = 一次性随机 nonce，映射关系存 kv_cache）
// ---------------------------------------------------------------------------
describe('buildAuthorizeUrl', () => {
  it('state 是 32 位随机 hex nonce（不是原始 userid），并落 kv_cache 行', async () => {
    const url = new URL(await buildAuthorizeUrl('alice'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(ENV.GITHUB_CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('public_repo');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.GITHUB_OAUTH_REDIRECT_URI);

    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(state).not.toBe('alice');

    expect(dbState.kvInsertCalls).toHaveLength(1);
    const row = dbState.kvInsertCalls[0];
    expect(row.key).toBe(`oauth_state_${state}`);
    expect(row.value).toEqual({ wecomUserid: 'alice' });
    // 有效期 now + 10 分钟。
    const ttlMs = new Date(row.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('两次调用生成不同 nonce（随机性，防固定 state 伪造）', async () => {
    const a = new URL(await buildAuthorizeUrl('alice'));
    const b = new URL(await buildAuthorizeUrl('alice'));
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
  });

  it('userid 带特殊字符（如 @）时完整存入 kv value（state 不再携带 userid）', async () => {
    const url = new URL(await buildAuthorizeUrl('alice@example.com'));
    const state = url.searchParams.get('state') ?? '';
    expect(state).not.toContain('@');
    expect(dbState.kvInsertCalls[0].value).toEqual({
      wecomUserid: 'alice@example.com',
    });
  });
});

// ---------------------------------------------------------------------------
// exchangeCode
// ---------------------------------------------------------------------------
describe('exchangeCode', () => {
  it('成功：POST 换 token 后拉取用户 login，返回 { login, token }', async () => {
    const fetchMock = stubFetch(SUCCESS_STEPS);

    const result = await exchangeCode('oauth-code');

    expect(result).toEqual({ login: 'alice-gh', token: 'gho_secret_token' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(tokenInit.method).toBe('POST');
    const body = JSON.parse(String(tokenInit.body)) as Record<string, string>;
    expect(body.code).toBe('oauth-code');
    expect(body.client_id).toBe(ENV.GITHUB_CLIENT_ID);
    expect(body.client_secret).toBe(ENV.GITHUB_CLIENT_SECRET);
    expect(body.redirect_uri).toBe(ENV.GITHUB_OAUTH_REDIRECT_URI);

    const [userUrl, userInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(userUrl).toBe('https://api.github.com/user');
    const headers = userInit.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gho_secret_token');
  });

  it('401 分支：HTTP 非 2xx 时抛错', async () => {
    stubFetch([{ ok: false, status: 401 }]);
    await expect(exchangeCode('bad-code')).rejects.toThrow(/401/);
  });

  it('网络错误分支：fetch reject 原样传播', async () => {
    stubFetch([new Error('network down')]);
    await expect(exchangeCode('oauth-code')).rejects.toThrow('network down');
  });

  it('响应 2xx 但缺 access_token（如 bad_verification_code）时抛错', async () => {
    stubFetch([{ ok: true, status: 200, json: { error: 'bad_verification_code' } }]);
    await expect(exchangeCode('expired')).rejects.toThrow(/bad_verification_code/);
  });

  it('token 有效但拉 user 失败（403）时抛错', async () => {
    stubFetch([
      { ok: true, status: 200, json: { access_token: 'gho_x', token_type: 'bearer' } },
      { ok: false, status: 403 },
    ]);
    await expect(exchangeCode('oauth-code')).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// encryptSecret / decryptSecret
// ---------------------------------------------------------------------------
describe('encryptSecret / decryptSecret', () => {
  it('往返一致：多种明文（含中文与类 token 串）加密后可解回原文', () => {
    for (const plain of [
      'gho_abcdef0123456789',
      '',
      '中文逗号，问号？与 emoji 🚀',
      'a'.repeat(300),
    ]) {
      const cipher = encryptSecret(plain);
      expect(decryptSecret(cipher)).toBe(plain);
    }
  });

  it('密文不等于明文，且同明文两次加密结果不同（随机 IV）', () => {
    const plain = 'gho_static_token';
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(plain);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it('篡改密文后解密抛错（AES-GCM 认证标签）', () => {
    const cipher = Buffer.from(encryptSecret('gho_token'), 'base64');
    cipher[cipher.length - 1] ^= 0xff;
    expect(() => decryptSecret(cipher.toString('base64'))).toThrow();
  });

  it('密文过短（畸形输入）时抛错而非静默返回', () => {
    expect(() => decryptSecret(Buffer.from('tiny').toString('base64'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// bindHandler（「绑定」→ 回复授权链接）
// ---------------------------------------------------------------------------
function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'gh_agent',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'text',
    content: '绑定',
    msgId: '2001',
    ...overrides,
  };
}

const searchHandlerMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  dbState.kvSelectRows.length = 0;
  dbState.kvSelectCalls.length = 0;
  dbState.kvInsertCalls.length = 0;
  dbState.kvDeleteCalls.length = 0;
  dbState.updateCalls.length = 0;
  dbState.updateRows.length = 0;
  apiMock.sendWeComText.mockResolvedValue(undefined);
  // 仅替换 search 兜底，保留 router 模块作用域注册的真实 bindHandler。
  registerHandlers({ search: searchHandlerMock });
});

describe('bindHandler', () => {
  beforeEach(() => {
    // Task 13：router 分发前会先 ensureSubscriber；钉一行「已开通」的订阅者
    // （select 桩返回非空即视为已存在），避免触发新用户欢迎语与多余 insert。
    dbState.kvSelectRows.push({
      key: 'subscriber-placeholder',
      value: {},
      expiresAt: new Date(0),
    });
  });

  it('content 为「绑定」→ 回复含授权链接的文本（state=随机 nonce，userid 落 kv_cache）', async () => {
    await routeMessage(makeMsg());

    expect(searchHandlerMock).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [userId, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(userId).toBe('alice');
    const url = new URL(content.split('\n').find((line) => line.startsWith('https://')) ?? '');
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(state).not.toBe('alice');
    expect(url.searchParams.get('scope')).toBe('public_repo');
    // nonce → userid 的映射已落 kv_cache。
    expect(dbState.kvInsertCalls).toHaveLength(1);
    expect(dbState.kvInsertCalls[0].key).toBe(`oauth_state_${state}`);
    expect(dbState.kvInsertCalls[0].value).toEqual({ wecomUserid: 'alice' });
  });

  it('前后空白经 trim 后仍精确命中「绑定」', async () => {
    await routeMessage(makeMsg({ content: '  绑定  ' }));
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('「绑定」后跟其他字 → 不进 bindHandler，回绑定用法提示（无需参数）', async () => {
    await routeMessage(makeMsg({ content: '绑定 GitHub' }));
    expect(searchHandlerMock).not.toHaveBeenCalled();
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('绑定');
    expect(content).toContain('无需参数');
  });

  it('可直接调用 bindHandler（不经 router）：state 是 bob 的 nonce 映射', async () => {
    await bindHandler(makeMsg({ fromUserName: 'bob' }));
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    const url = new URL(
      content.split('\n').find((line) => line.startsWith('https://')) ?? '',
    );
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(content).not.toContain('state=bob');
    expect(dbState.kvInsertCalls[0].value).toEqual({ wecomUserid: 'bob' });
  });
});

// ---------------------------------------------------------------------------
// api/oauth-github 回调端点
// ---------------------------------------------------------------------------
function mockRes(): OAuthResponse & {
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

function makeReq(query: Record<string, string | string[] | undefined>): OAuthRequest {
  return { method: 'GET', query };
}

/** 把 drizzle SQL 条件编译为文本 + 参数，便于断言（不触库）。 */
function compileCondition(condition: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition as SQL);
}

/** 预置一条 OAuth state 行（kv_cache），返回/使用其 nonce。 */
function seedStateRow(
  nonce: string,
  wecomUserid: string,
  options: { expired?: boolean } = {},
): void {
  dbState.kvSelectRows.push({
    key: `oauth_state_${nonce}`,
    value: { wecomUserid },
    expiresAt: options.expired
      ? new Date(Date.now() - 1000)
      : new Date(Date.now() + 10 * 60 * 1000),
  });
}

describe('api/oauth-github 回调端点', () => {
  it('成功：查 state 行 → 一次性消费 → exchange → 加密 token → 按映射 userid 更新 subscribers → 中文成功页', async () => {
    stubFetch(SUCCESS_STEPS);
    seedStateRow('a'.repeat(32), 'alice');
    dbState.updateRows.push({ id: 7 });
    const res = mockRes();

    await handler(makeReq({ code: 'oauth-code', state: 'a'.repeat(32) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('成功');
    expect(res.body).toContain('我的收藏');

    // state 行被一次性消费（DELETE）。
    expect(dbState.kvDeleteCalls).toHaveLength(1);
    expect(dbState.kvSelectRows).toHaveLength(0);

    expect(dbState.updateCalls).toHaveLength(1);
    const { values, condition } = dbState.updateCalls[0];
    expect(values.githubLogin).toBe('alice-gh');
    // 落库的是密文，且能用 decryptSecret 解回明文 token。
    expect(typeof values.githubTokenEnc).toBe('string');
    expect(values.githubTokenEnc).not.toBe('gho_secret_token');
    expect(decryptSecret(String(values.githubTokenEnc))).toBe('gho_secret_token');

    const compiled = compileCondition(condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');
  });

  it('重放防护：同一 state 第二次使用 → 错误页，不再写 subscribers', async () => {
    stubFetch(SUCCESS_STEPS);
    seedStateRow('b'.repeat(32), 'alice');
    dbState.updateRows.push({ id: 7 });

    const first = mockRes();
    await handler(makeReq({ code: 'oauth-code', state: 'b'.repeat(32) }), first);
    expect(first.statusCode).toBe(200);
    expect(dbState.updateCalls).toHaveLength(1);

    // 第二次：state 行已被消费（mock 的 delete 已弹出）。
    const second = mockRes();
    await handler(makeReq({ code: 'oauth-code', state: 'b'.repeat(32) }), second);

    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.body).toContain('失败');
    // 无任何新的 subscriber 写入，也不再触发 exchange。
    expect(dbState.updateCalls).toHaveLength(1);
    expect(dbState.kvDeleteCalls).toHaveLength(1);
    const fetchCallsAfterFirst = 2; // SUCCESS_STEPS 两连击只发生在第一次
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(fetchCallsAfterFirst);
  });

  it('state 行已过期 → 错误页，不 exchange、不写库、不消费（零写入）', async () => {
    const fetchMock = stubFetch([]);
    seedStateRow('c'.repeat(32), 'alice', { expired: true });
    const res = mockRes();

    await handler(makeReq({ code: 'oauth-code', state: 'c'.repeat(32) }), res);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('失败');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.updateCalls).toHaveLength(0);
    expect(dbState.kvDeleteCalls).toHaveLength(0);
    expect(dbState.kvSelectRows).toHaveLength(1); // 过期行原样保留（零写入）
  });

  it('state 行不存在（伪造/未知 state）→ 错误页，不 exchange、不写库', async () => {
    const fetchMock = stubFetch([]);
    const res = mockRes();

    await handler(makeReq({ code: 'oauth-code', state: 'd'.repeat(32) }), res);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('失败');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('缺 code → 中文错误页，不查 state、不 exchange、不写库', async () => {
    const fetchMock = stubFetch([]);
    const res = mockRes();

    await handler(makeReq({ state: 'alice' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('失败');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('缺 state → 中文错误页，不 exchange、不写库', async () => {
    const fetchMock = stubFetch([]);
    const res = mockRes();

    await handler(makeReq({ code: 'oauth-code' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('失败');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('exchange 失败（401）→ 中文错误页，不写库（state 已被消费，需重新绑定）', async () => {
    stubFetch([{ ok: false, status: 401 }]);
    seedStateRow('e'.repeat(32), 'alice');
    const res = mockRes();

    await handler(makeReq({ code: 'bad-code', state: 'e'.repeat(32) }), res);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('失败');
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('state 映射不到订阅者（update 影响 0 行）→ 中文错误页', async () => {
    stubFetch(SUCCESS_STEPS);
    seedStateRow('f'.repeat(32), 'ghost');
    dbState.updateRows.length = 0; // returning 空 → 无此 wecom_userid
    const res = mockRes();

    await handler(makeReq({ code: 'oauth-code', state: 'f'.repeat(32) }), res);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('失败');
  });

  it('非 GET 方法 → 405，不写库', async () => {
    const fetchMock = stubFetch([]);
    const res = mockRes();

    await handler({ method: 'POST', query: { code: 'x', state: 'y' } }, res);

    expect(res.statusCode).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.updateCalls).toHaveLength(0);
  });
});
