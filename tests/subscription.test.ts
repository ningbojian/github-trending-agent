import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「我的订阅」：用户得能看到自己到底订了什么，否则反馈/改设置都是盲操作。
 *
 * 三个模块一起测：store（读/改）、summary（纯函数排版）、handler（发消息）。
 * 关键约定：
 * - 读失败必须抛/回「读不到」，绝不能说成「没有订阅」；
 * - 改偏好只动 patch 里的键，未知字段原样保留；
 * - 删除关键词绝不碰 active（退订只能靠「退订」）。
 */
const dbMock = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: false,
  updateError: false,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (dbMock.readError) throw new Error('db down');
          return dbMock.rows;
        },
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => {
          if (dbMock.updateError) throw new Error('db down');
          dbMock.updates.push(payload);
        },
      }),
    }),
  }),
}));

vi.mock('../src/wecom/api', () => ({ sendWeComText: vi.fn() }));

import { formatSubscriptionSummary } from '../src/agent/subscription-summary';
import {
  mergePreferences,
  readSubscription,
  removeSubscriptionTerm,
} from '../src/agent/subscription-store';
import { sendWeComText } from '../src/wecom/api';
import {
  handleMySubscription,
  NO_SUBSCRIPTION_REPLY,
  SUBSCRIPTION_FAILURE_REPLY,
} from '../src/wecom/subscription';
import type { InboundMessage } from '../src/wecom/router';

function message(content: string): InboundMessage {
  return {
    toUserName: 'corp',
    fromUserName: 'u1',
    createTime: 0,
    msgType: 'text',
    content,
    msgId: '1',
  };
}

function sent(): string {
  const calls = vi.mocked(sendWeComText).mock.calls;
  return calls[calls.length - 1]?.[1] ?? '';
}

function subRow(preferences: Record<string, unknown>, active = true): Record<string, unknown> {
  return { id: 1, wecomUserid: 'u1', preferences, active };
}

beforeEach(() => {
  dbMock.rows = [];
  dbMock.readError = false;
  dbMock.updateError = false;
  dbMock.updates = [];
  vi.mocked(sendWeComText).mockClear();
});

describe('readSubscription', () => {
  it('没有订阅者行 → null', async () => {
    await expect(readSubscription('u1')).resolves.toBeNull();
  });

  it('有行 → active 与偏好原样返回', async () => {
    dbMock.rows = [subRow({ languages: ['go'], keywords: ['ai'] }, false)];

    await expect(readSubscription('u1')).resolves.toEqual({
      active: false,
      preferences: { languages: ['go'], keywords: ['ai'] },
    });
  });

  it('读失败必须抛（调用方据此区分「没有」与「读不到」）', async () => {
    dbMock.readError = true;
    await expect(readSubscription('u1')).rejects.toThrow();
  });
});

describe('mergePreferences', () => {
  it('只改 patch 里的键，未知字段原样保留', async () => {
    dbMock.rows = [
      subRow({
        languages: ['go'],
        keywords: ['ai'],
        digestCount: 5,
        pushTime: '10:00',
        intervalDays: 2,
        futureField: 'keep-me',
      }),
    ];

    await mergePreferences('u1', { digestCount: 3 });

    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0]).toEqual({
      preferences: {
        languages: ['go'],
        keywords: ['ai'],
        digestCount: 3,
        pushTime: '10:00',
        intervalDays: 2,
        futureField: 'keep-me',
      },
    });
    expect(dbMock.updates[0]).not.toHaveProperty('active');
  });

  it('可以显式带上 active（仅供「订阅」恢复推送）', async () => {
    dbMock.rows = [subRow({ languages: ['go'], keywords: ['ai'] }, false)];

    await mergePreferences('u1', { languages: [], keywords: ['rust'] }, { active: true });

    expect(dbMock.updates[0]).toMatchObject({
      preferences: { languages: [], keywords: ['rust'] },
      active: true,
    });
  });

  it('没有订阅者行 → 以空偏好为底写入 patch', async () => {
    await mergePreferences('u1', { digestCount: 4 });

    expect(dbMock.updates[0]).toEqual({
      preferences: { languages: [], keywords: [], digestCount: 4 },
    });
  });

  it('写失败必须抛（回执不能谎称改成功）', async () => {
    dbMock.updateError = true;
    await expect(mergePreferences('u1', { digestCount: 4 })).rejects.toThrow();
  });
});

describe('removeSubscriptionTerm', () => {
  it('大小写不敏感地删掉一个关键词，其余字段不动', async () => {
    dbMock.rows = [
      subRow({ languages: ['go'], keywords: ['AI', 'python'], digestCount: 6 }),
    ];

    await expect(removeSubscriptionTerm('u1', 'ai')).resolves.toEqual({
      removed: true,
      keywords: ['python'],
    });
    expect(dbMock.updates[0]).toEqual({
      preferences: { languages: ['go'], keywords: ['python'], digestCount: 6 },
    });
    expect(dbMock.updates[0]).not.toHaveProperty('active');
  });

  it('没命中 → 不写库', async () => {
    dbMock.rows = [subRow({ languages: [], keywords: ['python'] })];

    await expect(removeSubscriptionTerm('u1', 'rust')).resolves.toEqual({
      removed: false,
      keywords: ['python'],
    });
    expect(dbMock.updates).toEqual([]);
  });

  it('没有订阅者行 → 视为没命中，不写库', async () => {
    await expect(removeSubscriptionTerm('u1', 'ai')).resolves.toEqual({
      removed: false,
      keywords: [],
    });
    expect(dbMock.updates).toEqual([]);
  });
});

describe('formatSubscriptionSummary', () => {
  it('默认偏好：09:00、8 条、关键词未设置', () => {
    const text = formatSubscriptionSummary({ languages: [], keywords: [] }, true);

    expect(text).toContain('你的订阅');
    expect(text).toContain('已开通每日简报');
    expect(text).toContain('每天 09:00（北京时间）');
    expect(text).toContain('每次最多 8 条');
    expect(text).toContain('未设置');
    expect(text).toContain('「订阅 <偏好>」');
  });

  it('回显用户原始大小写（AI 不显示成 ai）', () => {
    const text = formatSubscriptionSummary(
      { languages: ['Go'], keywords: ['AI', 'python'] },
      true,
    );

    expect(text).toContain('AI、python');
    expect(text).toContain('语言过滤：Go');
  });

  it('退订状态与推送间隔如实显示', () => {
    const text = formatSubscriptionSummary(
      { languages: [], keywords: [], intervalDays: 3, pushTime: '21:30', digestCount: 5 },
      false,
    );

    expect(text).toContain('已退订');
    expect(text).toContain('21:30（北京时间），每 3 天推一次');
    expect(text).toContain('每次最多 5 条');
  });

  it('脏数据走同一套默认值（不显示 NaN/undefined）', () => {
    const text = formatSubscriptionSummary(
      { languages: 'nope', keywords: null, digestCount: 'x', pushTime: '25:99', intervalDays: 99 },
      true,
    );

    expect(text).toContain('每天 09:00（北京时间）');
    expect(text).toContain('每次最多 8 条');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  it('整条低于 1900 字节', () => {
    const text = formatSubscriptionSummary({ languages: [], keywords: [] }, true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1900);
  });
});

describe('handleMySubscription', () => {
  it('有订阅 → 发摘要（只读，不写库）', async () => {
    dbMock.rows = [subRow({ languages: [], keywords: ['ai'], digestCount: 5 })];

    await handleMySubscription(message('我的订阅'));

    expect(sent()).toContain('偏好关键词：ai');
    expect(sent()).toContain('每次最多 5 条');
    expect(dbMock.updates).toEqual([]);
  });

  it('没有订阅者行 → 引导开通，不冒充「已订阅」', async () => {
    await handleMySubscription(message('我的订阅'));
    expect(sent()).toBe(NO_SUBSCRIPTION_REPLY);
  });

  it('读失败 → 「暂时读不到」，绝不说「你没有订阅」', async () => {
    dbMock.readError = true;

    await handleMySubscription(message('我的订阅'));

    expect(sent()).toBe(SUBSCRIPTION_FAILURE_REPLY);
    expect(sent()).not.toContain('还没有');
  });
});
