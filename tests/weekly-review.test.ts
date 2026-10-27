import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 每周复盘：把「这周推了什么、你做了什么」变成一条能看懂的短消息。
 * 计算与文案是纯函数；投递走注入的依赖，测试里没有网络、没有真实时钟。
 */

const state = vi.hoisted(() => ({
  history: null as null | { items: Array<{ fullName: string; at: string }>; lastSentAt: string | null },
  events: [] as Array<{ at: string; kind: 'like' | 'dislike'; languages: string[]; topics: string[] }>,
  favoriteRows: [] as Array<{ createdAt: Date }>,
  userRows: [] as Array<{ wecomUserid: string }>,
}));

vi.mock('../src/agent/push-history', () => ({
  readPushHistory: async () => state.history,
}));

vi.mock('../src/agent/taste', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/taste')>();
  return {
    ...actual,
    readFeedback: async () => state.events,
  };
});

vi.mock('../src/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            // favorites 查收藏；subscribers 查活跃用户。
            return getTableName(table as never) === 'favorites'
              ? state.favoriteRows
              : state.userRows;
          },
        }),
      }),
    }),
  };
});

import {
  isWeeklyReviewSlot,
  pushWeeklyReviews,
  readWeekStats,
  shouldSendRecap,
  summarizeWeek,
  weeklyReviewText,
} from '../src/agent/weekly-review';

const NOW = new Date('2026-10-26T02:00:00Z'); // 周一 10:00 北京时间
const day = (offset: number): string =>
  new Date(NOW.getTime() - offset * 24 * 3600 * 1000).toISOString();

beforeEach(() => {
  state.history = null;
  state.events = [];
  state.favoriteRows = [];
  state.userRows = [];
});

describe('summarizeWeek', () => {
  it('只统计 7 天内的推送、收藏与反馈', () => {
    const stats = summarizeWeek(
      {
        history: {
          items: [
            { fullName: 'a/b', at: day(1) },
            { fullName: 'c/d', at: day(6) },
            { fullName: 'e/f', at: day(9) }, // 窗口外
          ],
          lastSentAt: day(1),
        },
        favoriteCount: 2,
        events: [
          { at: day(1), kind: 'like', languages: ['python'], topics: ['ai'] },
          { at: day(2), kind: 'like', languages: ['python'], topics: [] },
          { at: day(3), kind: 'dislike', languages: ['rust'], topics: [] },
          { at: day(8), kind: 'like', languages: ['go'], topics: [] }, // 窗口外
        ],
      },
      NOW,
    );
    expect(stats.pushed).toBe(2);
    expect(stats.favorited).toBe(2);
    expect(stats.liked).toBe(2);
    expect(stats.disliked).toBe(1);
    expect(stats.more).toContain('python');
    expect(stats.less).toEqual(['rust']);
  });

  it('没有反馈就没有「多推/少推」', () => {
    const stats = summarizeWeek({ history: null, favoriteCount: 0, events: [] }, NOW);
    expect(stats).toMatchObject({ pushed: 0, favorited: 0, liked: 0, disliked: 0, more: [], less: [] });
  });
});

describe('shouldSendRecap', () => {
  it('一整周零动静 → 不发（复盘不能变成噪音）', () => {
    expect(
      shouldSendRecap({
        pushed: 0,
        favorited: 0,
        liked: 0,
        disliked: 0,
        more: [],
        less: [],
      }),
    ).toBe(false);
  });

  it('只要收到过推送就值得发', () => {
    expect(
      shouldSendRecap({
        pushed: 3,
        favorited: 0,
        liked: 0,
        disliked: 0,
        more: [],
        less: [],
      }),
    ).toBe(true);
  });
});

describe('weeklyReviewText', () => {
  it('数字、方向与调整方式都在（不承诺做不了的事）', () => {
    const text = weeklyReviewText(
      {
        pushed: 12,
        favorited: 2,
        liked: 3,
        disliked: 1,
        more: ['python'],
        less: ['rust'],
      },
      NOW,
    );
    expect(text).toContain('收到 12 条');
    expect(text).toContain('收藏 2 个');
    expect(text).toContain('3 次感兴趣');
    expect(text).toContain('1 次不感兴趣');
    expect(text).toContain('多推：python');
    expect(text).toContain('少推：rust');
    expect(text).toContain('订阅');
  });
});

describe('isWeeklyReviewSlot', () => {
  it('北京时间周一 10 点后 → 是', () => {
    expect(isWeeklyReviewSlot(NOW)).toBe(true);
  });

  it('周一 9 点前 → 不是（等整点后那班 cron）', () => {
    expect(isWeeklyReviewSlot(new Date('2026-10-26T01:30:00Z'))).toBe(false);
  });

  it('周日 / 周二 → 不是', () => {
    expect(isWeeklyReviewSlot(new Date('2026-10-25T02:00:00Z'))).toBe(false);
    expect(isWeeklyReviewSlot(new Date('2026-10-27T02:00:00Z'))).toBe(false);
  });
});

describe('readWeekStats', () => {
  it('收藏数按当前用户与时间窗从库里取', async () => {
    state.history = { items: [{ fullName: 'a/b', at: day(1) }], lastSentAt: day(1) };
    state.events = [{ at: day(2), kind: 'like', languages: ['go'], topics: [] }];
    state.favoriteRows = [{ createdAt: NOW }, { createdAt: NOW }];
    const stats = await readWeekStats('u1', NOW);
    expect(stats).toMatchObject({ pushed: 1, favorited: 2, liked: 1 });
  });
});

describe('pushWeeklyReviews', () => {
  function harness(overrides: Partial<Parameters<typeof pushWeeklyReviews>[0]> = {}) {
    const sent: Array<{ userid: string; text: string }> = [];
    const marked: string[] = [];
    const options = {
      now: NOW,
      listUsers: async () => ['u1', 'u2', 'u3'],
      loadStats: async (userid: string) =>
        userid === 'u2'
          ? { pushed: 0, favorited: 0, liked: 0, disliked: 0, more: [], less: [] }
          : { pushed: 5, favorited: 1, liked: 1, disliked: 0, more: ['python'], less: [] },
      alreadySent: async () => false,
      markSent: async (userid: string) => {
        marked.push(userid);
      },
      send: async (userid: string, text: string) => {
        sent.push({ userid, text });
      },
      suggest: async () => undefined,
      ...overrides,
    };
    return { options, sent, marked };
  }

  it('只发给有动静的人，并记周标记', async () => {
    const { options, sent, marked } = harness();
    const result = await pushWeeklyReviews(options);
    expect(sent.map((entry) => entry.userid)).toEqual(['u1', 'u3']);
    expect(marked).toEqual(['u1', 'u3']);
    expect(result).toEqual({ sent: 2, skipped: 1, failed: 0 });
  });

  it('一周内已经发过 → 跳过，不重复打扰', async () => {
    const { options, sent } = harness({ alreadySent: async (userid) => userid === 'u1' });
    const result = await pushWeeklyReviews(options);
    expect(sent.map((entry) => entry.userid)).toEqual(['u3']);
    expect(result.skipped).toBe(2);
  });

  it('单个人失败不影响其他人', async () => {
    const { options, sent } = harness({
      send: async (userid: string, text: string) => {
        if (userid === 'u1') throw new Error('400');
        sent.push({ userid, text });
      },
    });
    const result = await pushWeeklyReviews(options);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(sent.map((entry) => entry.userid)).toEqual(['u3']);
  });

  it('给收到复盘的人追加偏好建议；建议失败不算复盘失败', async () => {
    const suggested: string[] = [];
    const { options } = harness({
      suggest: async (userid: string) => {
        if (userid === 'u1') throw new Error('send failed');
        suggested.push(userid);
      },
    });
    const result = await pushWeeklyReviews(options);
    expect(suggested).toEqual(['u3']);
    expect(result).toEqual({ sent: 2, skipped: 1, failed: 0 });
  });

  it('不在发送窗口（周日）→ 一个人都不读', async () => {
    const { options, sent } = harness({ now: new Date('2026-10-25T02:00:00Z') });
    expect(await pushWeeklyReviews(options)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sent).toEqual([]);
  });
});
