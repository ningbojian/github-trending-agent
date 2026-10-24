import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * env 惰性单例策略：env Proxy 首次属性访问才 loadEnv 并缓存，跨用例切换必须
 * vi.stubEnv 后 vi.resetModules + 动态 import（沿用 tests/config.test.ts 先例）。
 * 本文件在触碰 env 前给 schema 全部必填 key 填占位值（loadEnv 要求全量必填）。
 * 凭据为单元测试专用假值（非真实密钥）。
 */
const BASE_ENV: Record<string, string> = {
  NEON_DATABASE_URL: 'postgres://test',
  LLM_PROVIDER: 'openai',
  LLM_API_KEY: 'unit-test-llm-key',
  LLM_MODEL: 'unit-test-model',
  WECOM_CORP_ID: 'ww-test',
  WECOM_AGENT_ID: '1000002',
  WECOM_SECRET: 'unit-test-secret',
  WECOM_CALLBACK_TOKEN: 'unit-test-callback-token',
  WECOM_CALLBACK_AES_KEY: 'unit-test-aes-key',
  GITHUB_CLIENT_ID: 'unit-test-client-id',
  GITHUB_CLIENT_SECRET: 'unit-test-client-secret',
  GITHUB_OAUTH_REDIRECT_URI: 'https://agent.example.com/api/oauth-github',
  CRON_SECRET: 'unit-test-cron-secret',
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key',
};

/**
 * db mock（供 src/wecom/api 的 kv_cache 读写）。
 * 桩沿用 tests/callback.test.ts 的宽松风格：select 预钉一行新鲜 token（tok-123），
 * 命中即免走 gettoken fetch——每用例 fetch 只会被 message/send 调一次。
 */
const dbState = vi.hoisted(() => ({
  selectRows: [] as Array<Record<string, unknown>>,
  insertValues: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/db/client.js', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...dbState.selectRows]),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbState.insertValues.push(values);
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  }),
}));

type RelayOverrides = Partial<{
  WECOM_RELAY_URL: string | undefined;
  WECOM_RELAY_SECRET: string | undefined;
}>;

/**
 * 按用例注入 env：先 stubEnv 全量（override 传 undefined 即删键），再重置模块
 * 缓存并动态 import——否则 env Proxy 的 loadEnv 结果在首例后粘滞不变。
 */
async function loadApiWithEnv(overrides: RelayOverrides = {}) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const api = await import('../src/wecom/api.js');
  api.resetAccessTokenCache();
  return api;
}

/** 桩 fetch：单次成功应答 { errcode: 0 }（照抄 tests/callback.test.ts 模式）。 */
function stubFetchOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // kv token 预钉新鲜行：getWeComAccessToken 直接命中，不触发 gettoken。
  dbState.selectRows = [
    {
      key: 'wecom_access_token',
      value: { token: 'tok-123' },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  ];
  dbState.insertValues = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sendWeComText — message/send 出站中转（env 门控）', () => {
  it('WECOM_RELAY_URL + WECOM_RELAY_SECRET 皆有值 → 走中转并带 X-Relay-Secret 头', async () => {
    const { sendWeComText } = await loadApiWithEnv({
      WECOM_RELAY_URL: 'http://relay.test:18080',
      WECOM_RELAY_SECRET: 'unit-relay-secret',
    });
    const fetchMock = stubFetchOk();

    await sendWeComText('alice', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://relay.test:18080/cgi-bin/message/send?access_token=tok-123');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Relay-Secret']).toBe('unit-relay-secret');
    expect(headers['content-type']).toBe('application/json');
  });

  it('WECOM_RELAY_URL 有值、secret 无值 → 走中转但不带 X-Relay-Secret 头', async () => {
    const { sendWeComText } = await loadApiWithEnv({
      WECOM_RELAY_URL: 'http://relay.test:18080',
      WECOM_RELAY_SECRET: undefined,
    });
    const fetchMock = stubFetchOk();

    await sendWeComText('alice', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://relay.test:18080/cgi-bin/message/send?access_token=tok-123');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Relay-Secret']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  it('WECOM_RELAY_URL 无值 → 直连 qyapi（回归守卫，与 callback.test.ts 同形），无中转头', async () => {
    const { sendWeComText } = await loadApiWithEnv({
      WECOM_RELAY_URL: undefined,
      WECOM_RELAY_SECRET: undefined,
    });
    const fetchMock = stubFetchOk();

    await sendWeComText('alice', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=tok-123',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Relay-Secret']).toBeUndefined();
  });

  it('WECOM_RELAY_URL 带尾斜杠 → 请求 URL 无双斜杠', async () => {
    const { sendWeComText } = await loadApiWithEnv({
      WECOM_RELAY_URL: 'http://relay.test:18080/',
      WECOM_RELAY_SECRET: undefined,
    });
    const fetchMock = stubFetchOk();

    await sendWeComText('alice', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://relay.test:18080/cgi-bin/message/send?access_token=tok-123');
    expect(url).not.toContain('//cgi-bin');
  });
});
