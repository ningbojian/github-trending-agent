import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 企微成员数探测：db / api / fetch 全部打桩，绝不触网。 */
const dbState = vi.hoisted(() => ({
  kvRows: [] as Array<Record<string, unknown>>,
  insertCalls: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  insertError: undefined as Error | undefined,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...dbState.kvRows]),
      }),
    }),
    insert: () => ({
      values: (values: { key: string; value: unknown; expiresAt: Date }) => {
        dbState.insertCalls.push(values);
        return {
          onConflictDoUpdate: async () => {
            if (dbState.insertError) throw dbState.insertError;
          },
        };
      },
    }),
  }),
}));

vi.mock('../src/wecom/api', () => ({
  getWeComAccessToken: async () => 'tok-123',
}));

const ENV = vi.hoisted(() => ({
  WECOM_ACCEPTING: undefined as string | undefined,
  WECOM_MEMBER_LIMIT: undefined as string | undefined,
}));

vi.mock('../src/config', () => ({ env: ENV }));

import {
  DEFAULT_MEMBER_LIMIT,
  getWeComMemberCount,
  isWeComAccepting,
  refreshWeComMemberCount,
  weComMemberLimit,
} from '../src/wecom/capacity';

function stubSimpleList(
  response:
    | Error
    | { ok: boolean; status: number; json?: unknown },
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  if (response instanceof Error) {
    fetchMock.mockRejectedValue(response);
  } else {
    fetchMock.mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function userList(count: number) {
  return {
    errcode: 0,
    errmsg: 'ok',
    userlist: Array.from({ length: count }, (_, index) => ({
      userid: `user-${index}`,
    })),
  };
}

beforeEach(() => {
  dbState.kvRows = [];
  dbState.insertCalls = [];
  dbState.insertError = undefined;
  ENV.WECOM_ACCEPTING = undefined;
  ENV.WECOM_MEMBER_LIMIT = undefined;
  vi.unstubAllGlobals();
});

describe('weComMemberLimit', () => {
  it('defaults to 100 and accepts positive integers', () => {
    expect(DEFAULT_MEMBER_LIMIT).toBe(100);
    expect(weComMemberLimit()).toBe(100);
    ENV.WECOM_MEMBER_LIMIT = '500';
    expect(weComMemberLimit()).toBe(500);
  });

  it('falls back to 100 for invalid values', () => {
    for (const raw of ['0', '-5', 'abc', '2.5', '']) {
      ENV.WECOM_MEMBER_LIMIT = raw;
      expect(weComMemberLimit()).toBe(100);
    }
  });
});

describe('getWeComMemberCount', () => {
  it('asks user/simplelist for department 1 with children and caches the count', async () => {
    const fetchMock = stubSimpleList({ ok: true, status: 200, json: userList(42) });

    const count = await getWeComMemberCount();

    expect(count).toBe(42);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/cgi-bin/user/simplelist');
    expect(url).toContain('access_token=tok-123');
    expect(url).toContain('department_id=1');
    expect(url).toContain('fetch_child=1');
    expect(dbState.insertCalls[0].key).toBe('wecom_member_count');
    expect(dbState.insertCalls[0].value).toEqual({ count: 42 });
  });

  it('bounds the probe with a timeout so a stalled API cannot block the cron', async () => {
    // cron 在推送前 await 这个探测：接口卡死不能拖住整轮推送（maxDuration=300s）。
    const fetchMock = stubSimpleList({
      ok: true,
      status: 200,
      json: userList(3),
    });

    await getWeComMemberCount();

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves a fresh cached count without hitting the API', async () => {
    dbState.kvRows = [
      {
        key: 'wecom_member_count',
        value: { count: 7 },
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const fetchMock = stubSimpleList({ ok: true, status: 200, json: userList(99) });

    expect(await getWeComMemberCount()).toBe(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores an expired cache entry', async () => {
    dbState.kvRows = [
      {
        key: 'wecom_member_count',
        value: { count: 7 },
        expiresAt: new Date(Date.now() - 1000),
      },
    ];
    const fetchMock = stubSimpleList({ ok: true, status: 200, json: userList(9) });

    expect(await getWeComMemberCount()).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the cache read when forced (hourly cron refresh)', async () => {
    dbState.kvRows = [
      {
        key: 'wecom_member_count',
        value: { count: 7 },
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const fetchMock = stubSimpleList({ ok: true, status: 200, json: userList(12) });

    expect(await refreshWeComMemberCount()).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on HTTP errors, errcode errors and network failures', async () => {
    stubSimpleList({ ok: false, status: 500 });
    expect(await getWeComMemberCount({ force: true })).toBeNull();

    stubSimpleList({ ok: true, status: 200, json: { errcode: 60011, errmsg: 'no privilege' } });
    expect(await getWeComMemberCount({ force: true })).toBeNull();

    stubSimpleList(new Error('ECONNRESET'));
    expect(await getWeComMemberCount({ force: true })).toBeNull();
  });

  it('still returns the count when the cache write fails', async () => {
    stubSimpleList({ ok: true, status: 200, json: userList(33) });
    dbState.insertError = new Error('cache down');

    expect(await getWeComMemberCount()).toBe(33);
  });
});

describe('isWeComAccepting', () => {
  it('honours the explicit WECOM_ACCEPTING override without probing', async () => {
    const fetchMock = stubSimpleList({ ok: true, status: 200, json: userList(200) });
    ENV.WECOM_ACCEPTING = 'true';
    expect(await isWeComAccepting()).toBe(true);
    ENV.WECOM_ACCEPTING = 'FALSE ';
    expect(await isWeComAccepting()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts while the probed count is below the limit', async () => {
    stubSimpleList({ ok: true, status: 200, json: userList(99) });
    expect(await isWeComAccepting()).toBe(true);
  });

  it('stops accepting once the probed count reaches the limit', async () => {
    ENV.WECOM_MEMBER_LIMIT = '100';
    stubSimpleList({ ok: true, status: 200, json: userList(100) });
    expect(await isWeComAccepting()).toBe(false);
  });

  it('falls back to accepting when the probe fails', async () => {
    stubSimpleList({ ok: false, status: 403 });
    expect(await isWeComAccepting()).toBe(true);
  });
});
