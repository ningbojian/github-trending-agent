import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 解析结果缓存：命中就完全不调模型。
 * db 层用替身，不连库；时间用真实 Date（30 天 TTL 用区间断言）。
 */
const dbMock = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  throwOnRead: false,
  throwOnWrite: false,
  insertValues: [] as Record<string, unknown>[],
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (dbMock.throwOnRead) throw new Error('db down');
          return dbMock.rows;
        },
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        if (dbMock.throwOnWrite) throw new Error('db down');
        dbMock.insertValues.push(row as Record<string, unknown>);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

import {
  normalizeQueryText,
  queryCacheKey,
  readCachedQuery,
  writeCachedQuery,
} from '../src/agent/query-cache';
import type { SearchQuery } from '../src/agent/parse-query';

const DAY_MS = 24 * 60 * 60 * 1000;

const QUERY: SearchQuery = {
  intent: 'search',
  languages: ['rust'],
  keywords: ['ai'],
  period: 'week',
  minStars: null,
  sortBy: 'stars_delta',
  topN: 10,
};

beforeEach(() => {
  dbMock.rows = [];
  dbMock.throwOnRead = false;
  dbMock.throwOnWrite = false;
  dbMock.insertValues = [];
});

describe('normalizeQueryText', () => {
  it('去掉首尾空白并把连续空白折叠成一个空格', () => {
    expect(normalizeQueryText('  本周  rust \n\t的 ai  ')).toBe('本周 rust 的 ai');
  });

  it('不做大小写转换（保留用户原话，避免改变关键词语义）', () => {
    expect(normalizeQueryText('Rust AI')).toBe('Rust AI');
  });
});

describe('queryCacheKey', () => {
  it('同一句话（空白不同）得到同一个 key', () => {
    expect(queryCacheKey('本周 rust 的 ai')).toBe(queryCacheKey(' 本周 rust   的 ai '));
  });

  it('不同文本得到不同 key', () => {
    expect(queryCacheKey('rust')).not.toBe(queryCacheKey('python'));
  });

  it('带版本前缀，改 prompt 时可整批失效', () => {
    const key = queryCacheKey('rust');
    expect(key.startsWith('parse:v1:')).toBe(true);
    expect(key).toBe(
      'parse:v1:' +
        createHash('sha1').update(normalizeQueryText('rust')).digest('hex'),
    );
  });
});

describe('readCachedQuery', () => {
  it('命中时返回校验后的查询对象', async () => {
    dbMock.rows = [{ value: QUERY, expiresAt: new Date(Date.now() + DAY_MS) }];

    await expect(readCachedQuery('rust')).resolves.toEqual(QUERY);
  });

  it('没有行 → null', async () => {
    await expect(readCachedQuery('rust')).resolves.toBeNull();
  });

  it('已过期的行 → null（过期判定在代码里，不依赖库的时钟）', async () => {
    dbMock.rows = [{ value: QUERY, expiresAt: new Date(Date.now() - 1000) }];

    await expect(readCachedQuery('rust')).resolves.toBeNull();
  });

  it('值不符合 schema → 当未命中，而不是把坏值当查询用', async () => {
    dbMock.rows = [
      { value: { intent: 'nonsense' }, expiresAt: new Date(Date.now() + DAY_MS) },
    ];

    await expect(readCachedQuery('rust')).resolves.toBeNull();
  });

  it('库挂了 → null（缓存永远不能把搜索弄挂）', async () => {
    dbMock.throwOnRead = true;

    await expect(readCachedQuery('rust')).resolves.toBeNull();
  });
});

describe('writeCachedQuery', () => {
  it('按 key upsert，TTL 30 天', async () => {
    await writeCachedQuery('  本周  rust ', QUERY);

    expect(dbMock.insertValues).toHaveLength(1);
    const row = dbMock.insertValues[0] as {
      key: string;
      value: SearchQuery;
      expiresAt: Date;
    };
    expect(row.key).toBe(queryCacheKey('本周 rust'));
    expect(row.value).toEqual(QUERY);
    const ttl = row.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
    expect(ttl).toBeLessThanOrEqual(30 * DAY_MS);
  });

  it('写失败不抛（缓存是优化，不是正确性依赖）', async () => {
    dbMock.throwOnWrite = true;

    await expect(writeCachedQuery('rust', QUERY)).resolves.toBeUndefined();
  });
});
