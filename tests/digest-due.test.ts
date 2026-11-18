import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anyDigestDue, readDueSnapshot } from '../src/agent/digest-due';

const dbMock = vi.hoisted(() => ({
  wecom: [] as Array<Record<string, unknown>>,
  email: [] as Array<Record<string, unknown>>,
  fail: false,
  call: 0,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (dbMock.fail) throw new Error('db down');
          const rows = dbMock.call === 0 ? dbMock.wecom : dbMock.email;
          dbMock.call += 1;
          return rows;
        },
      }),
    }),
  }),
}));

/** 2026-11-01 10:00 北京时间（02:00Z）。 */
const NOW = new Date('2026-11-01T02:00:00.000Z');

beforeEach(() => {
  dbMock.wecom.length = 0;
  dbMock.email.length = 0;
  dbMock.fail = false;
  dbMock.call = 0;
});

describe('anyDigestDue', () => {
  it('企微用户到了推送时间且今天没发 → true', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '10:00', intervalDays: 1 },
      lastDigestAt: null,
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(true);
  });

  it('推送时间还没到 → false', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '11:00', intervalDays: 1 },
      lastDigestAt: null,
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(false);
  });

  it('今天已经发过 → false', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '10:00', intervalDays: 1 },
      lastDigestAt: new Date('2026-10-31T16:00:00.000Z'), // 北京 11-01 00:00
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(false);
  });

  it('间隔未到 → false；间隔到了 → true', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '10:00', intervalDays: 2 },
      lastDigestAt: new Date('2026-10-30T02:00:00.000Z'), // 10-30 10:00 北京
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(true);

    dbMock.wecom[0]!.lastDigestAt = new Date('2026-10-31T02:00:00.000Z');
    await expect(anyDigestDue(NOW)).resolves.toBe(false);
  });

  it('只有已确认的邮箱用户到点也算 due', async () => {
    dbMock.email.push({
      preferences: { pushTime: '09:00', intervalDays: 1 },
      lastSentAt: null,
      confirmed: true,
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(true);
  });

  it('未确认邮箱永远不算 due（避免每个 tick 都进重活路径）', async () => {
    dbMock.email.push({
      preferences: { pushTime: '09:00', intervalDays: 1 },
      lastSentAt: null,
      confirmed: false,
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(false);
  });

  it('已确认邮箱，18:00 之后不再算 due', async () => {
    const afterWindow = new Date('2026-11-01T12:00:00.000Z'); // 北京 20:00
    dbMock.email.push({
      preferences: { pushTime: '09:00', intervalDays: 1 },
      lastSentAt: null,
      confirmed: true,
    });
    await expect(anyDigestDue(afterWindow)).resolves.toBe(false);
  });

  it('查询失败 → fail-open（当作有人到点）', async () => {
    dbMock.fail = true;
    await expect(anyDigestDue(NOW)).resolves.toBe(true);
  });
});

describe('readDueSnapshot — 保守 due 窗口', () => {
  it('企微到点：窗口从 pushTime 到当天结束', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '10:00', intervalDays: 1 },
      lastDigestAt: null,
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: true,
      windows: [{ start: 600, end: 1440 }],
    });
  });

  it('企微还没到点：窗口仍覆盖今天稍后的 pushTime', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '11:00', intervalDays: 1 },
      lastDigestAt: null,
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: false,
      windows: [{ start: 660, end: 1440 }],
    });
  });

  it('企微今天已发：不产生窗口', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '10:00', intervalDays: 1 },
      lastDigestAt: new Date('2026-10-31T16:00:00.000Z'), // 北京 11-01 00:00
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: false,
      windows: [],
    });
  });

  it('邮箱窗口从 pushTime 到 18:00', async () => {
    dbMock.email.push({
      preferences: { pushTime: '09:00', intervalDays: 1 },
      lastSentAt: null,
      confirmed: true,
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: true,
      windows: [{ start: 540, end: 1080 }],
    });
  });

  it('未确认邮箱不产生窗口', async () => {
    dbMock.email.push({
      preferences: { pushTime: '09:00', intervalDays: 1 },
      lastSentAt: null,
      confirmed: false,
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: false,
      windows: [],
    });
  });

  it('间隔未到：不产生窗口', async () => {
    dbMock.wecom.push({
      preferences: { pushTime: '10:00', intervalDays: 2 },
      lastDigestAt: new Date('2026-10-31T02:00:00.000Z'), // 北京 10-31 10:00
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: false,
      windows: [],
    });
  });

  it('重叠/相邻窗口合并为一段', async () => {
    dbMock.wecom.push(
      {
        preferences: { pushTime: '09:00', intervalDays: 1 },
        lastDigestAt: null,
      },
      {
        preferences: { pushTime: '10:00', intervalDays: 1 },
        lastDigestAt: null,
      },
    );
    dbMock.email.push({
      preferences: { pushTime: '10:00', intervalDays: 1 },
      lastSentAt: null,
      confirmed: true,
    });
    await expect(readDueSnapshot(NOW)).resolves.toEqual({
      dueNow: true,
      windows: [{ start: 540, end: 1440 }],
    });
  });
});
