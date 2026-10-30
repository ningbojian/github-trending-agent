import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAST_REPO_TTL_MS,
  lastRepoKey,
  readLastRepo,
  rememberRepo,
} from '../src/agent/last-repo';

const dbMock = vi.hoisted(() => ({
  selectRows: [] as Array<{ value: unknown; expiresAt: Date }>,
  inserted: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  failSelect: false,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (dbMock.failSelect) throw new Error('db down');
          return [...dbMock.selectRows];
        },
      }),
    }),
    insert: () => ({
      values: (values: { key: string; value: unknown; expiresAt: Date }) => ({
        onConflictDoUpdate: async () => {
          dbMock.inserted.push(values);
        },
      }),
    }),
  }),
}));

beforeEach(() => {
  dbMock.selectRows.length = 0;
  dbMock.inserted.length = 0;
  dbMock.failSelect = false;
});

const NOW = new Date('2026-10-30T08:00:00.000Z');

describe('short-term repo memory', () => {
  it('有效记录 → 返回仓库名', async () => {
    dbMock.selectRows.push({
      value: { fullName: 'vercel/next.js' },
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await expect(readLastRepo('alice', NOW)).resolves.toBe('vercel/next.js');
  });

  it('过期记录 → 当作没有', async () => {
    dbMock.selectRows.push({
      value: { fullName: 'vercel/next.js' },
      expiresAt: new Date(NOW.getTime() - 1),
    });
    await expect(readLastRepo('alice', NOW)).resolves.toBeNull();
  });

  it('读取异常 → null（不阻塞回复）', async () => {
    dbMock.failSelect = true;
    await expect(readLastRepo('alice', NOW)).resolves.toBeNull();
  });

  it('rememberRepo 写入 30 分钟 TTL', async () => {
    await rememberRepo('alice', 'astral-sh/ruff', NOW);
    expect(dbMock.inserted).toHaveLength(1);
    expect(dbMock.inserted[0]!.key).toBe(lastRepoKey('alice'));
    expect(dbMock.inserted[0]!.value).toEqual({ fullName: 'astral-sh/ruff' });
    expect(dbMock.inserted[0]!.expiresAt.getTime()).toBe(
      NOW.getTime() + LAST_REPO_TTL_MS,
    );
  });
});
