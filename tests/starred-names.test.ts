import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 网页端 star：用户很可能是在 GitHub 网页上点的 star，本地 favorites 没有行。
 * 这里只负责「把 star 名单取回来」，推送过滤由调用方合并进画像。
 * 读缓存 / 拉 API 的任何失败都不抛——最差只是这次不做额外过滤。
 */
const dbMock = vi.hoisted(() => ({
  rows: [] as Array<{ value: unknown; expiresAt: Date }>,
  readError: false,
  writeError: false,
  insertValues: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (dbMock.readError) throw new Error('db down');
            return dbMock.rows;
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if (dbMock.writeError) throw new Error('db down');
        dbMock.insertValues.push(row);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

vi.mock('../src/github/oauth', () => ({
  decryptSecret: (enc: string) => {
    if (enc === 'corrupt') throw new Error('bad ciphertext');
    return 'gho_test_token';
  },
}));

import {
  loadStarredNames,
  MAX_STARRED_NAMES,
  STARRED_NAMES_TTL_MS,
} from '../src/github/starred-names';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T02:00:00.000Z');
const TOKEN_ENC = 'enc:gho_test_token';
const LOGIN = 'octocat';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

function starred(payload: Array<{ full_name: string }>): void {
  fetchMock.mockResolvedValue(jsonResponse(payload));
}

function cached(names: string[], expiresInDays = 1): void {
  dbMock.rows = [{ value: { names }, expiresAt: new Date(NOW.getTime() + expiresInDays * DAY_MS) }];
}

beforeEach(() => {
  dbMock.rows = [];
  dbMock.readError = false;
  dbMock.writeError = false;
  dbMock.insertValues = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('loadStarredNames', () => {
  it('未绑定（没有 token）→ null，不读缓存也不请求', async () => {
    await expect(loadStarredNames('u1', null, LOGIN, NOW)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.insertValues).toHaveLength(0);
  });

  it('没有 login → null（拼不出端点）', async () => {
    await expect(loadStarredNames('u1', TOKEN_ENC, null, NOW)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缓存未过期 → 直接返回，不调 GitHub', async () => {
    cached(['owner/repo']);

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toEqual({
      names: ['owner/repo'],
      cached: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缓存过期 → 拉 GitHub 并写 24 小时缓存', async () => {
    cached(['stale/repo'], -1);
    starred([{ full_name: 'Owner/Repo' }, { full_name: 'other/one' }]);

    const result = await loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW);

    expect(result).toEqual({ names: ['owner/repo', 'other/one'], cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/users/${LOGIN}/starred`);
    expect(url).toContain('per_page=100');

    const row = dbMock.insertValues[0] as { key: string; expiresAt: Date };
    expect(row.key).toBe('stars:v1:u1');
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + STARRED_NAMES_TTL_MS);
    expect(STARRED_NAMES_TTL_MS).toBe(DAY_MS);
  });

  it('名字一律归一成小写（GitHub 大小写不保证一致）', async () => {
    starred([{ full_name: 'Some/Owner-Repo' }, { full_name: 'Some/Owner-Repo' }]);

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toEqual({
      names: ['some/owner-repo'],
      cached: false,
    });
  });

  it(`最多留 ${MAX_STARRED_NAMES} 条`, async () => {
    starred(
      Array.from({ length: MAX_STARRED_NAMES + 20 }, (_, i) => ({ full_name: `owner/repo-${i}` })),
    );

    const result = await loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW);
    expect(result?.names).toHaveLength(MAX_STARRED_NAMES);
  });

  it('拉取失败（非 200）→ 用过期缓存兜底，不写新缓存', async () => {
    cached(['old/repo'], -1);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'boom' }, 500));

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toEqual({
      names: ['old/repo'],
      cached: true,
    });
    expect(dbMock.insertValues).toHaveLength(0);
  });

  it('拉取失败且没有旧缓存 → null，不抛', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toBeNull();
    expect(dbMock.insertValues).toHaveLength(0);
  });

  it('返回体不是数组 → 当作失败，不缓存坏值', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nope: true }));

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toBeNull();
    expect(dbMock.insertValues).toHaveLength(0);
  });

  it('缓存值形状坏掉 → 当作没有缓存，去拉一次', async () => {
    dbMock.rows = [{ value: { names: 'nope' }, expiresAt: new Date(NOW.getTime() + DAY_MS) }];
    starred([{ full_name: 'a/b' }]);

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toEqual({
      names: ['a/b'],
      cached: false,
    });
  });

  it('读缓存失败 → 当作没有缓存，照常去拉', async () => {
    dbMock.readError = true;
    starred([{ full_name: 'a/b' }]);

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toEqual({
      names: ['a/b'],
      cached: false,
    });
  });

  it('写缓存失败不影响返回值（推送过滤不能因为记账失败而失效）', async () => {
    dbMock.writeError = true;
    starred([{ full_name: 'a/b' }]);

    await expect(loadStarredNames('u1', TOKEN_ENC, LOGIN, NOW)).resolves.toEqual({
      names: ['a/b'],
      cached: false,
    });
  });

  it('token 解密失败且没有旧缓存 → null，不请求', async () => {
    await expect(loadStarredNames('u1', 'corrupt', LOGIN, NOW)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('token 解密失败但有旧缓存 → 用旧名单（多过滤比再推一遍安全）', async () => {
    cached(['old/repo'], -1);

    await expect(loadStarredNames('u1', 'corrupt', LOGIN, NOW)).resolves.toEqual({
      names: ['old/repo'],
      cached: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
