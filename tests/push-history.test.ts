import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 推送历史：7 天去重窗口 + 「上次发消息是哪天」（静默补助用）。 */
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

import {
  DEDUP_DAYS,
  PUSH_HISTORY_MAX,
  PUSH_HISTORY_TTL_MS,
  pushedRecently,
  readPushHistory,
  recordPush,
  type PushHistory,
} from '../src/agent/push-history';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T02:00:00.000Z');

function history(items: Array<[string, number]>, lastSentAt: string | null = NOW.toISOString()): PushHistory {
  return {
    items: items.map(([fullName, daysAgo]) => ({
      fullName,
      at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    })),
    lastSentAt,
  };
}

function stored(value: unknown, expiresInDays = 30): void {
  dbMock.rows = [{ value, expiresAt: new Date(NOW.getTime() + expiresInDays * DAY_MS) }];
}

function lastWrite(): { key: string; value: PushHistory; expiresAt: Date } {
  return dbMock.insertValues[dbMock.insertValues.length - 1] as {
    key: string;
    value: PushHistory;
    expiresAt: Date;
  };
}

beforeEach(() => {
  dbMock.rows = [];
  dbMock.readError = false;
  dbMock.writeError = false;
  dbMock.insertValues = [];
});

describe('readPushHistory', () => {
  it('没有记录 → null（= 当天不做去重）', async () => {
    await expect(readPushHistory('u1', NOW)).resolves.toBeNull();
  });

  it('超期行当作没有', async () => {
    dbMock.rows = [{ value: history([]), expiresAt: new Date(NOW.getTime() - 1) }];
    await expect(readPushHistory('u1', NOW)).resolves.toBeNull();
  });

  it('坏形状 → null，不抛', async () => {
    stored({ items: 'nope' });
    await expect(readPushHistory('u1', NOW)).resolves.toBeNull();
  });

  it('合法值原样读回（丢掉形状坏的条目）', async () => {
    stored({
      items: [
        { fullName: 'a/b', at: NOW.toISOString() },
        { fullName: 42, at: NOW.toISOString() },
        'garbage',
      ],
      lastSentAt: NOW.toISOString(),
    });

    const result = await readPushHistory('u1', NOW);
    expect(result?.items).toEqual([{ fullName: 'a/b', at: NOW.toISOString() }]);
    expect(result?.lastSentAt).toBe(NOW.toISOString());
  });

  it('读库失败 → null（读不到历史就不能把推送弄挂）', async () => {
    dbMock.readError = true;
    await expect(readPushHistory('u1', NOW)).resolves.toBeNull();
  });
});

describe('recordPush', () => {
  it('写 pushed:<userid>，带 60 天过期，并刷新 lastSentAt', async () => {
    await recordPush('u1', ['a/b', 'c/d'], NOW);

    const row = lastWrite();
    expect(row.key).toBe('pushed:u1');
    expect(row.value.items.map((i) => i.fullName)).toEqual(['a/b', 'c/d']);
    expect(row.value.lastSentAt).toBe(NOW.toISOString());
    expect(PUSH_HISTORY_TTL_MS).toBe(60 * DAY_MS);
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + PUSH_HISTORY_TTL_MS);
  });

  it('同一个仓库再推一次 → 只留一条，时间更新为最新（7 天窗口重新开始）', async () => {
    stored(history([['a/b', 3]]));

    await recordPush('u1', ['a/b'], NOW);

    const row = lastWrite();
    expect(row.value.items).toHaveLength(1);
    expect(row.value.items[0].at).toBe(NOW.toISOString());
  });

  it(`最多留 ${PUSH_HISTORY_MAX} 条，最旧的被挤掉`, async () => {
    const old: Array<[string, number]> = Array.from({ length: PUSH_HISTORY_MAX }, (_, i) => [
      `old/${i}`,
      10 + i,
    ]);
    stored(history(old));

    await recordPush('u1', ['new/one'], NOW);

    const row = lastWrite();
    expect(row.value.items).toHaveLength(PUSH_HISTORY_MAX);
    expect(row.value.items[0].fullName).toBe('new/one');
    expect(row.value.items.some((i) => i.fullName === `old/${PUSH_HISTORY_MAX - 1}`)).toBe(false);
  });

  it('空列表（静默日）也刷新 lastSentAt——静默补助靠它算「几天没说话」', async () => {
    stored(history([['a/b', 1]], '2026-10-20T02:00:00.000Z'));

    await recordPush('u1', [], NOW);

    const row = lastWrite();
    expect(row.value.items).toHaveLength(1);
    expect(row.value.lastSentAt).toBe(NOW.toISOString());
  });

  it('写失败只记日志，不抛（推送已经发出去了，不能因记账失败报错）', async () => {
    dbMock.writeError = true;
    await expect(recordPush('u1', ['a/b'], NOW)).resolves.toBeUndefined();
  });
});

describe('pushedRecently', () => {
  it('7 天窗口内推过 → true；第 8 天 → false', () => {
    const h = history([['a/b', 6], ['c/d', DEDUP_DAYS], ['e/f', DEDUP_DAYS + 1]]);
    expect(pushedRecently(h, 'a/b', NOW)).toBe(true);
    expect(pushedRecently(h, 'c/d', NOW)).toBe(true);
    expect(pushedRecently(h, 'e/f', NOW)).toBe(false);
  });

  it('没有历史 / 没推过的仓库 → false', () => {
    expect(pushedRecently(null, 'a/b', NOW)).toBe(false);
    expect(pushedRecently(history([['a/b', 1]]), 'x/y', NOW)).toBe(false);
  });

  it('大小写不同也算推过（GitHub 名字大小写不保证一致）', () => {
    const h = history([['Owner/Repo', 2]]);
    expect(pushedRecently(h, 'owner/repo', NOW)).toBe(true);
    expect(pushedRecently(h, 'owner/repo2', NOW)).toBe(false);
  });
});
