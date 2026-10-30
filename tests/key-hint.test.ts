import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_HINT_COOLDOWN_MS, keyHintKey, takeKeyHint } from '../src/agent/key-hint';

const dbMock = vi.hoisted(() => ({
  selectRows: [] as Array<{ expiresAt: Date }>,
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

describe('takeKeyHint', () => {
  it('没有记录 → 提示一次，并写入 7 天冷却', async () => {
    await expect(takeKeyHint('alice', NOW)).resolves.toBe(true);
    expect(dbMock.inserted).toHaveLength(1);
    expect(dbMock.inserted[0]!.key).toBe(keyHintKey('alice'));
    expect(dbMock.inserted[0]!.expiresAt.getTime()).toBe(
      NOW.getTime() + KEY_HINT_COOLDOWN_MS,
    );
  });

  it('冷却期内 → 不再提示，也不覆盖原记录', async () => {
    dbMock.selectRows.push({ expiresAt: new Date(NOW.getTime() + 1000) });
    await expect(takeKeyHint('alice', NOW)).resolves.toBe(false);
    expect(dbMock.inserted).toHaveLength(0);
  });

  it('记录已过期 → 重新提示并刷新冷却', async () => {
    dbMock.selectRows.push({ expiresAt: new Date(NOW.getTime() - 1) });
    await expect(takeKeyHint('alice', NOW)).resolves.toBe(true);
    expect(dbMock.inserted).toHaveLength(1);
  });

  it('存储异常 → 不提示（fail-closed，不刷屏）', async () => {
    dbMock.failSelect = true;
    await expect(takeKeyHint('alice', NOW)).resolves.toBe(false);
  });
});
