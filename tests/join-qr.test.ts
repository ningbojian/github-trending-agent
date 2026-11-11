import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...dbState.rows]),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbState.writes.push(values);
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  }),
}));

const apiState = vi.hoisted(() => ({
  contactsCalls: [] as Array<[string, string]>,
}));

vi.mock('../src/wecom/api', () => ({
  getWeComAccessToken: async () => 'test-token',
  getWeComAccessTokenForSecret: async (secret: string, cacheKey: string) => {
    apiState.contactsCalls.push([secret, cacheKey]);
    return 'contacts-token';
  },
}));

const { getJoinQrUrl } = await import('../src/wecom/join-qr');

const NOW = new Date('2026-11-11T10:00:00Z');

function cacheRow(url: string, fetchedAt: Date, expiresAt: Date) {
  return {
    key: 'wecom:join-qr:v1',
    value: { url, fetchedAt: fetchedAt.toISOString() },
    expiresAt,
  };
}

const fetchMock = vi.fn();

function apiReturns(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  dbState.rows = [];
  dbState.writes = [];
  apiState.contactsCalls = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.WECOM_RELAY_URL;
  delete process.env.WECOM_RELAY_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WECOM_RELAY_URL;
  delete process.env.WECOM_RELAY_SECRET;
});

describe('getJoinQrUrl', () => {
  it('缓存未满 24 小时时不调接口', async () => {
    dbState.rows = [
      cacheRow(
        'https://wework.qpic.cn/cached.png',
        new Date(NOW.getTime() - 60 * 60 * 1000),
        new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      ),
    ];

    await expect(getJoinQrUrl(NOW)).resolves.toBe('https://wework.qpic.cn/cached.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缓存超过 24 小时就换新码并写回缓存', async () => {
    dbState.rows = [
      cacheRow(
        'https://wework.qpic.cn/old.png',
        new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      ),
    ];
    apiReturns({ errcode: 0, errmsg: 'ok', join_qrcode: 'https://wework.qpic.cn/fresh.png' });

    await expect(getJoinQrUrl(NOW)).resolves.toBe('https://wework.qpic.cn/fresh.png');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/cgi-bin/corp/get_join_qrcode');
    expect(dbState.writes).toHaveLength(1);
    expect(dbState.writes[0]).toMatchObject({
      key: 'wecom:join-qr:v1',
      value: {
        url: 'https://wework.qpic.cn/fresh.png',
        fetchedAt: NOW.toISOString(),
      },
    });
  });

  it('接口失败时回退到仍在有效期内的旧码', async () => {
    dbState.rows = [
      cacheRow(
        'https://wework.qpic.cn/old.png',
        new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      ),
    ];
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(getJoinQrUrl(NOW)).resolves.toBe('https://wework.qpic.cn/old.png');
  });

  it('接口失败且没有缓存时返回 null，让页面降级', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(getJoinQrUrl(NOW)).resolves.toBeNull();
  });

  it('接口返回错误码时返回 null，不把错误页当二维码', async () => {
    apiReturns({ errcode: 60011, errmsg: 'no privilege' });

    await expect(getJoinQrUrl(NOW)).resolves.toBeNull();
  });

  it('把 http 图片地址升级为 https，避免混合内容', async () => {
    apiReturns({ errcode: 0, join_qrcode: 'http://wework.qpic.cn/qr.png' });

    await expect(getJoinQrUrl(NOW)).resolves.toBe('https://wework.qpic.cn/qr.png');
  });

  it('缓存已过期时不再回退', async () => {
    dbState.rows = [
      cacheRow(
        'https://wework.qpic.cn/expired.png',
        new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        new Date(NOW.getTime() - 60 * 60 * 1000),
      ),
    ];
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(getJoinQrUrl(NOW)).resolves.toBeNull();
  });

  it('有通讯录同步 Secret 时用独立 token 调用', async () => {
    apiReturns({ errcode: 0, join_qrcode: 'https://wework.qpic.cn/qr.png' });

    await expect(getJoinQrUrl(NOW, 'contacts-secret')).resolves.toBe(
      'https://wework.qpic.cn/qr.png',
    );

    expect(apiState.contactsCalls).toEqual([
      ['contacts-secret', 'wecom_contacts_access_token'],
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'access_token=contacts-token',
    );
  });

  it('配置了固定 IP 中转时走中转并带 X-Relay-Secret', async () => {
    process.env.WECOM_RELAY_URL = 'https://relay.example.com/';
    process.env.WECOM_RELAY_SECRET = 'relay-secret';
    apiReturns({ errcode: 0, join_qrcode: 'https://wework.qpic.cn/qr.png' });

    await expect(getJoinQrUrl(NOW, 'contacts-secret')).resolves.toBe(
      'https://wework.qpic.cn/qr.png',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://relay.example.com/cgi-bin/corp/get_join_qrcode?access_token=contacts-token&size_type=3',
    );
    expect((init.headers as Record<string, string>)['X-Relay-Secret']).toBe(
      'relay-secret',
    );
  });
});
