import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  failSelect: false,
}));

vi.mock('../src/db/client', async () => {
  const { kvCache } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (dbMock.failSelect) throw new Error('db down');
            return Promise.resolve(table === kvCache ? [...dbMock.rows] : []);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: async () => {
            dbMock.writes.push({ table, values });
          },
        }),
      }),
    }),
  };
});

import {
  hideOpportunity,
  markOpportunitiesShown,
  readHiddenOpportunities,
  readShownOpportunities,
} from '../src/opportunities/store';

beforeEach(() => {
  dbMock.rows = [];
  dbMock.writes = [];
  dbMock.failSelect = false;
});

describe('opportunity store', () => {
  it('读取 hidden/shown 集合', async () => {
    dbMock.rows = [{ value: { ids: ['a', 'b'], updatedAt: 'now' } }];
    await expect(readHiddenOpportunities('u1')).resolves.toEqual(
      new Set(['a', 'b']),
    );
    await expect(readShownOpportunities('u1')).resolves.toEqual(
      new Set(['a', 'b']),
    );
  });

  it('读失败返回空集合', async () => {
    dbMock.failSelect = true;
    await expect(readHiddenOpportunities('u1')).resolves.toEqual(new Set());
    await expect(readShownOpportunities('u1')).resolves.toEqual(new Set());
  });

  it('过期行不再生效', async () => {
    dbMock.rows = [
      {
        value: { ids: ['a', 'b'] },
        expiresAt: new Date(Date.now() - 1000),
      },
    ];
    await expect(readHiddenOpportunities('u1')).resolves.toEqual(new Set());
  });

  it('hide 追加并去重，保留最近 200 条', async () => {
    dbMock.rows = [
      { value: { ids: Array.from({ length: 200 }, (_, i) => `id-${i}`) } },
    ];
    await hideOpportunity('u1', 'new-id');
    const values = dbMock.writes[0]!.values as {
      key: string;
      value: { ids: string[] };
      expiresAt: Date;
    };
    expect(values.key).toBe('opportunity-hidden:u1');
    expect(values.value.ids).toHaveLength(200);
    expect(values.value.ids).toContain('new-id');
    expect(values.value.ids).not.toContain('id-0');
    expect(values.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('markShown 合并、去重并写入 shown key', async () => {
    dbMock.rows = [{ value: { ids: ['old'] } }];
    await markOpportunitiesShown('u1', ['x', 'y', 'x']);
    const values = dbMock.writes[0]!.values as {
      key: string;
      value: { entries: Array<{ id: string; at: string }> };
    };
    expect(values.key).toBe('opportunity-shown:u1');
    expect(values.value.entries.map((entry) => entry.id)).toEqual([
      'old',
      'x',
      'y',
    ]);
    expect(
      values.value.entries.every((entry) => Number.isFinite(Date.parse(entry.at))),
    ).toBe(true);
  });

  it('shown 支持 7 天窗口，旧条目不影响新窗口', async () => {
    const now = Date.now();
    dbMock.rows = [
      {
        value: {
          entries: [
            {
              id: 'fresh',
              at: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'old',
              at: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ],
        },
      },
    ];
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    await expect(
      readShownOpportunities('email:1', sevenDays),
    ).resolves.toEqual(new Set(['fresh']));
    await expect(readShownOpportunities('email:1')).resolves.toEqual(
      new Set(['fresh', 'old']),
    );
  });
});
