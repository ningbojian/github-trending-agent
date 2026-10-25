import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 端点 /api/set-key：网页表单填自己的 AI Key。
 * 凭证、DB、连接测试全部 mock —— 绝不触网、不连库、不校验真实 Key。
 */

const ENV = vi.hoisted(() => ({
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key',
  PUBLIC_BASE_URL: 'https://agent.example.com',
}));

vi.mock('../src/config', () => ({ env: ENV }));

const dbState = vi.hoisted(() => ({
  kvRows: [] as Array<Record<string, unknown>>,
  insertValues: [] as Array<Record<string, unknown>>,
  insertError: undefined as Error | undefined,
}));

vi.mock('../src/db/client', async () => {
  const { kvCache } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(table === kvCache ? [...dbState.kvRows] : []),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          const run = async (): Promise<void> => {
            if (dbState.insertError) throw dbState.insertError;
            dbState.insertValues.push(values);
          };
          return {
            onConflictDoUpdate: run,
            then: (
              resolve: (value: unknown) => unknown,
              reject?: (err: unknown) => unknown,
            ) => run().then(() => undefined).then(resolve, reject),
          };
        },
      }),
    }),
  };
});

const tokenMock = vi.hoisted(() => ({ verifySetKeyToken: vi.fn() }));

vi.mock('../src/agent/setkey-token', () => ({
  SETKEY_TTL_MS: 15 * 60 * 1000,
  verifySetKeyToken: tokenMock.verifySetKeyToken,
}));

const userLlmMock = vi.hoisted(() => ({
  saveUserLlm: vi.fn(),
  pingLlm: vi.fn(),
}));

vi.mock('../src/agent/user-llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/user-llm')>();
  return {
    ...actual,
    saveUserLlm: userLlmMock.saveUserLlm,
    pingLlm: userLlmMock.pingLlm,
  };
});

import handler from '../api/set-key';

const TOKEN = 'payload.signature';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): { state: CapturedResponse; res: Parameters<typeof handler>[1] } {
  const state: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: string) {
      state.body = body;
      return res;
    },
  };
  return { state, res };
}

async function call(
  request: Parameters<typeof handler>[0],
): Promise<CapturedResponse> {
  const { state, res } = makeRes();
  await handler(request, res);
  return state;
}

const KEY = 'sk-user-secret-key-99999999';

function postBody(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: KEY,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.kvRows = [];
  dbState.insertValues = [];
  dbState.insertError = undefined;
  tokenMock.verifySetKeyToken.mockReset();
  tokenMock.verifySetKeyToken.mockReturnValue({ userid: 'alice', jti: 'jti-1' });
  userLlmMock.saveUserLlm.mockReset();
  userLlmMock.saveUserLlm.mockResolvedValue(undefined);
  userLlmMock.pingLlm.mockReset();
  userLlmMock.pingLlm.mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// GET：渲染表单
// ---------------------------------------------------------------------------
describe('GET /api/set-key', () => {
  it('缺 token → 400，不回表单', async () => {
    const out = await call({ method: 'GET', query: {} });
    expect(out.status).toBe(400);
    expect(out.body).not.toContain('name="apiKey"');
  });

  it('token 无效/过期（verify 返回 null）→ 400', async () => {
    tokenMock.verifySetKeyToken.mockReturnValue(null);
    const out = await call({ method: 'GET', query: { t: 'bad' } });
    expect(out.status).toBe(400);
    expect(out.body).toContain('链接');
  });

  it('有效 token → 200 表单：三个输入框 + 预设入口 + token 回填', async () => {
    const out = await call({ method: 'GET', query: { t: TOKEN } });
    expect(out.status).toBe(200);
    expect(out.body).toContain('name="baseUrl"');
    expect(out.body).toContain('name="model"');
    expect(out.body).toContain('name="apiKey"');
    expect(out.body).toContain('DeepSeek');
    expect(out.body).toContain(encodeURIComponent(TOKEN));
  });

  it('?p=deepseek 预设 → Base URL 与模型名已预填', async () => {
    const out = await call({ method: 'GET', query: { t: TOKEN, p: 'deepseek' } });
    expect(out.status).toBe(200);
    expect(out.body).toContain('value="https://api.deepseek.com/v1"');
    expect(out.body).toContain('value="deepseek-chat"');
  });

  it('token 已用过（jti 已消费）→ 400，不再给表单', async () => {
    dbState.kvRows = [{ key: 'setkey-used:jti-1' }];
    const out = await call({ method: 'GET', query: { t: TOKEN } });
    expect(out.status).toBe(400);
    expect(out.body).not.toContain('name="apiKey"');
  });
});

// ---------------------------------------------------------------------------
// POST：保存
// ---------------------------------------------------------------------------
describe('POST /api/set-key', () => {
  it('非 https 的 Base URL → 400，不落库、不试连', async () => {
    const out = await call({
      method: 'POST',
      query: { t: TOKEN },
      body: postBody({ baseUrl: 'http://api.deepseek.com/v1' }),
    });
    expect(out.status).toBe(400);
    expect(userLlmMock.saveUserLlm).not.toHaveBeenCalled();
    expect(userLlmMock.pingLlm).not.toHaveBeenCalled();
    expect(out.body).toContain('https://');
  });

  it('试连失败 → 400 回表单 + 原因，不落库', async () => {
    userLlmMock.pingLlm.mockResolvedValue({ ok: false, error: '接口返回 401：invalid key' });
    const out = await call({
      method: 'POST',
      query: { t: TOKEN },
      body: postBody(),
    });
    expect(out.status).toBe(400);
    expect(out.body).toContain('401');
    expect(userLlmMock.saveUserLlm).not.toHaveBeenCalled();
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('成功 → 保存到该用户、消费 jti、200 提示已保存', async () => {
    const out = await call({
      method: 'POST',
      query: { t: TOKEN },
      body: postBody(),
    });

    expect(userLlmMock.pingLlm).toHaveBeenCalledWith({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: KEY,
    });
    expect(userLlmMock.saveUserLlm).toHaveBeenCalledWith('alice', {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: KEY,
    });
    expect(dbState.insertValues[0]?.key).toBe('setkey-used:jti-1');
    expect(out.status).toBe(200);
    expect(out.body).toContain('已保存');
  });

  it('同一 token 二次提交 → 400，不重复落库', async () => {
    dbState.kvRows = [{ key: 'setkey-used:jti-1' }];
    const out = await call({
      method: 'POST',
      query: { t: TOKEN },
      body: postBody(),
    });
    expect(out.status).toBe(400);
    expect(userLlmMock.saveUserLlm).not.toHaveBeenCalled();
    expect(out.body).not.toContain('已保存');
  });

  it('落库失败 → 400，且不回显任何 Key 片段', async () => {
    userLlmMock.saveUserLlm.mockRejectedValue(new Error('db down'));
    const out = await call({
      method: 'POST',
      query: { t: TOKEN },
      body: postBody(),
    });
    expect(out.status).toBe(400);
    expect(out.body).not.toContain(KEY);
    expect(out.body).not.toContain(KEY.slice(-6));
  });

  it('请求体里带 JSON 字符串（Vercel 预解析）同样可用', async () => {
    const out = await call({
      method: 'POST',
      query: { t: TOKEN },
      body: JSON.stringify(postBody()),
    });
    expect(out.status).toBe(200);
    expect(userLlmMock.saveUserLlm).toHaveBeenCalledTimes(1);
  });
});
