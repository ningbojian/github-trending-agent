import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anyDigestDue } from '../src/agent/digest-due';

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

  it('只有邮箱用户到点也算 due', async () => {
    dbMock.email.push({
      preferences: { pushTime: '09:00', intervalDays: 1 },
      lastSentAt: null,
    });
    await expect(anyDigestDue(NOW)).resolves.toBe(true);
  });

  it('查询失败 → fail-open（当作有人到点）', async () => {
    dbMock.fail = true;
    await expect(anyDigestDue(NOW)).resolves.toBe(true);
  });
});
