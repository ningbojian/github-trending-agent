import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 订阅冲突：订阅了「rpa」，却连续三次对 rpa 方向「不感兴趣」。
 *
 * 约定：
 * - 只有累计到阈值（3 次）才提示，一次噪声不算；
 * - 同一个词 30 天内只提示一次；
 * - 只提示、不自动改订阅；用户回「取消订阅 <词>」才真的删；
 * - 提示是反馈回执之后的第二条消息，失败绝不能影响回执。
 */
const state = vi.hoisted(() => ({
  subscription: null as {
    active: boolean;
    preferences: Record<string, unknown>;
  } | null,
  readSubError: false,
  events: [] as Array<{
    at: string;
    kind: 'like' | 'dislike';
    languages: string[];
    topics: string[];
  }>,
  markers: new Map<string, Date>(),
  writes: [] as Array<{ key: string; expiresAt: Date }>,
  markerReadError: false,
  markerWriteError: false,
  sendError: false,
  removed: { removed: true, keywords: [] as string[] },
  removeError: false,
  removeCalls: [] as string[],
}));

vi.mock('../src/agent/subscription-store', () => ({
  readSubscription: async () => {
    if (state.readSubError) throw new Error('db down');
    return state.subscription;
  },
  removeSubscriptionTerm: async (_userid: string, term: string) => {
    state.removeCalls.push(term);
    if (state.removeError) throw new Error('db down');
    return state.removed;
  },
}));

vi.mock('../src/agent/taste', () => ({
  readFeedback: async () => state.events,
}));

vi.mock('../src/db/client', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  return {
    db: () => ({
      select: () => ({
        from: () => ({
          where: (condition: unknown) => ({
            limit: async () => {
              if (state.markerReadError) throw new Error('db down');
              const key = new PgDialect().sqlToQuery(condition as never).params[0];
              const expiresAt = state.markers.get(String(key));
              return expiresAt === undefined ? [] : [{ expiresAt }];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (row: { key: string; expiresAt: Date }) => ({
          onConflictDoUpdate: async () => {
            if (state.markerWriteError) throw new Error('db down');
            state.writes.push(row);
            state.markers.set(row.key, row.expiresAt);
          },
        }),
      }),
    }),
  };
});

vi.mock('../src/wecom/api', () => ({
  sendWeComText: vi.fn(async () => {
    if (state.sendError) throw new Error('send failed');
  }),
}));

import {
  CONFLICT_PROMPT_TTL_MS,
  CONFLICT_THRESHOLD,
  conflictPrompt,
  conflictTerms,
  maybePromptConflict,
} from '../src/agent/conflict';
import { sendWeComText } from '../src/wecom/api';
import {
  handleCancelSubscriptionTerm,
  SUBSCRIPTION_FAILURE_REPLY,
} from '../src/wecom/subscription';
import type { InboundMessage } from '../src/wecom/router';

const NOW = new Date('2026-10-27T09:00:00.000Z');

function event(
  kind: 'like' | 'dislike',
  languages: string[],
  topics: string[] = [],
): { at: string; kind: 'like' | 'dislike'; languages: string[]; topics: string[] } {
  return { at: NOW.toISOString(), kind, languages, topics };
}

function subscribed(keywords: string[]): void {
  state.subscription = { active: true, preferences: { languages: [], keywords } };
}

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

function sentTexts(): string[] {
  return vi.mocked(sendWeComText).mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  state.subscription = null;
  state.readSubError = false;
  state.events = [];
  state.markers.clear();
  state.writes = [];
  state.markerReadError = false;
  state.markerWriteError = false;
  state.sendError = false;
  state.removed = { removed: true, keywords: [] };
  state.removeError = false;
  state.removeCalls = [];
  vi.mocked(sendWeComText).mockClear();
});

describe('conflictTerms', () => {
  it('只数「不感兴趣」，且同一条事件不重复计', () => {
    const events = [
      event('dislike', ['rpa'], ['rpa']),
      event('dislike', ['RPA']),
      event('dislike', ['rpa']),
      event('like', ['rpa']),
    ];

    expect(conflictTerms(events, ['rpa'])).toEqual([
      { term: 'rpa', count: 3 },
    ]);
  });

  it('达到阈值才出现（3 次）', () => {
    const two = [event('dislike', ['rpa']), event('dislike', ['rpa'])];
    const three = [...two, event('dislike', ['rpa'])];

    expect(CONFLICT_THRESHOLD).toBe(3);
    expect(conflictTerms(two, ['rpa'])).toEqual([]);
    expect(conflictTerms(three, ['rpa'])).toEqual([{ term: 'rpa', count: 3 }]);
  });

  it('多次冲突按次数降序，并列按名字', () => {
    const events = [
      event('dislike', ['go']),
      event('dislike', ['go']),
      event('dislike', ['go']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['ai']),
      event('dislike', ['ai']),
      event('dislike', ['ai']),
      event('dislike', ['ai']),
    ];

    expect(conflictTerms(events, ['go', 'rpa', 'ai']).map((c) => c.term)).toEqual([
      'ai',
      'go',
      'rpa',
    ]);
  });

  it('订阅词大小写与空白不影响匹配', () => {
    const three = [
      event('dislike', ['RPA']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];

    expect(conflictTerms(three, [' RPA '])).toEqual([{ term: 'rpa', count: 3 }]);
  });
});

describe('maybePromptConflict', () => {
  it('第 3 次「不感兴趣」才发提示（回执之后的第二条消息）', async () => {
    subscribed(['rpa']);
    state.events = [event('dislike', ['rpa']), event('dislike', ['rpa'])];

    await maybePromptConflict('u1', NOW);
    expect(sendWeComText).not.toHaveBeenCalled();

    state.events = [...state.events, event('dislike', ['rpa'])];
    await maybePromptConflict('u1', NOW);

    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('「rpa」');
    expect(sentTexts()[0]).toContain('取消订阅 rpa');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.key).toBe('conflict:v1:u1:rpa');
  });

  it('30 天内的标记会压住重复提示', async () => {
    subscribed(['rpa']);
    state.events = [
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];
    state.markers.set('conflict:v1:u1:rpa', new Date(NOW.getTime() + 1000));

    await maybePromptConflict('u1', NOW);

    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('标记过期后可以再次提示', async () => {
    subscribed(['rpa']);
    state.events = [
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];
    state.markers.set('conflict:v1:u1:rpa', new Date(NOW.getTime() - 1));

    await maybePromptConflict('u1', NOW);

    expect(sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('标记 TTL 是 30 天', async () => {
    subscribed(['rpa']);
    state.events = [
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];

    await maybePromptConflict('u1', NOW);

    const expiresAt = state.writes[0]?.expiresAt.getTime();
    expect(expiresAt).toBe(NOW.getTime() + CONFLICT_PROMPT_TTL_MS);
  });

  it('没有订阅关键词 → 不读事件也不提示', async () => {
    subscribed([]);
    state.events = [
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];

    await maybePromptConflict('u1', NOW);
    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('一次最多提示一个词（取计数最高者）', async () => {
    subscribed(['go', 'rpa']);
    state.events = [
      event('dislike', ['go']),
      event('dislike', ['go']),
      event('dislike', ['go']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];

    await maybePromptConflict('u1', NOW);

    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('取消订阅 rpa');
  });

  it('发送失败 → 不写标记（下次还能再提示）', async () => {
    subscribed(['rpa']);
    state.events = [
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];
    state.sendError = true;

    await maybePromptConflict('u1', NOW);

    expect(state.writes).toHaveLength(0);
  });

  it('标记读失败按「已提示」处理，不骚扰', async () => {
    subscribed(['rpa']);
    state.events = [
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
      event('dislike', ['rpa']),
    ];
    state.markerReadError = true;

    await maybePromptConflict('u1', NOW);

    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('限流之外的任何故障都不向外抛', async () => {
    state.readSubError = true;

    await expect(maybePromptConflict('u1', NOW)).resolves.toBeUndefined();
  });

  it('提示文案给出精确命令，并说明不回复也可', () => {
    const text = conflictPrompt('rpa');
    expect(text).toContain('取消订阅 rpa');
    expect(text).toContain('保持原样');
  });
});

describe('「取消订阅 <关键词>」', () => {
  it('删掉关键词并回执当前剩余', async () => {
    state.removed = { removed: true, keywords: ['python'] };

    await handleCancelSubscriptionTerm(message('取消订阅 rpa'));

    expect(state.removeCalls).toEqual(['rpa']);
    expect(sentTexts()[0]).toContain('已从订阅关键词里移除「rpa」');
    expect(sentTexts()[0]).toContain('python');
  });

  it('删完最后一个词 → 明确说明回到全站热榜', async () => {
    state.removed = { removed: true, keywords: [] };

    await handleCancelSubscriptionTerm(message('取消订阅 rpa'));

    expect(sentTexts()[0]).toContain('全站热榜');
  });

  it('词不在订阅里 → 不写库的提示（handler 不报成功）', async () => {
    state.removed = { removed: false, keywords: ['python'] };

    await handleCancelSubscriptionTerm(message('取消订阅 rpa'));

    expect(sentTexts()[0]).toContain('没有「rpa」');
    expect(sentTexts()[0]).toContain('我的订阅');
  });

  it('裸「取消订阅」→ 用法提示，不调用存储', async () => {
    await handleCancelSubscriptionTerm(message('取消订阅'));

    expect(state.removeCalls).toEqual([]);
    expect(sentTexts()[0]).toContain('取消订阅 <关键词>');
  });

  it('前缀不是「取消订阅」→ 静默返回', async () => {
    await handleCancelSubscriptionTerm(message('取消收藏 1'));

    expect(sendWeComText).not.toHaveBeenCalled();
    expect(state.removeCalls).toEqual([]);
  });

  it('存储失败 → 「暂时改不了」，不谎称已删', async () => {
    state.removeError = true;

    await handleCancelSubscriptionTerm(message('取消订阅 rpa'));

    expect(sentTexts()[0]).toBe(SUBSCRIPTION_FAILURE_REPLY);
  });
});
