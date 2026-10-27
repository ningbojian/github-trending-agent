import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 多轮状态：系统问一句「要不要记住」，用户回一个字就算答复。
 * 只支持单槽、5 分钟有效；任何其它消息都清空，绝不产生幽灵状态。
 */

const state = vi.hoisted(() => ({
  row: null as null | { value: unknown; expiresAt: Date },
  readError: false,
  writes: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  writeError: false,
  deletes: [] as string[],
  remembered: [] as string[],
  rememberStatus: 'added' as 'added' | 'duplicate' | 'full' | 'error',
  profile: null as null | { facts: string[]; updatedAt: string },
}));

vi.mock('../src/db/client', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  return {
    db: () => ({
      select: () => ({
        from: () => ({
          where: (condition: unknown) => ({
            limit: async () => {
              if (state.readError) throw new Error('db down');
              const key = new PgDialect().sqlToQuery(condition as never).params[0];
              if (state.row === null) return [];
              return [{ key: String(key), value: state.row.value, expiresAt: state.row.expiresAt }];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (row: { key: string; value: unknown; expiresAt: Date }) => ({
          onConflictDoUpdate: async () => {
            if (state.writeError) throw new Error('db down');
            state.writes.push(row);
          },
        }),
      }),
      delete: () => ({
        where: async (condition: unknown) => {
          const key = new PgDialect().sqlToQuery(condition as never).params[0];
          state.deletes.push(String(key));
        },
      }),
    }),
  };
});

vi.mock('../src/agent/profile', () => ({
  readProfile: async () => state.profile,
  rememberFact: async (_userid: string, fact: string) => {
    state.remembered.push(fact);
    return state.rememberStatus;
  },
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: vi.fn(async () => undefined),
}));

const onboardingMock = vi.hoisted(() => ({
  handleSubscribe: vi.fn(async (_msg: { content: string; fromUserName: string }) => undefined),
}));

vi.mock('../src/wecom/onboarding', () => ({
  handleSubscribe: onboardingMock.handleSubscribe,
}));

import {
  PENDING_TTL_MS,
  buildSuggestionFact,
  clearPending,
  interpretConfirmation,
  interpretKeyword,
  readPending,
  setPending,
  suggestionText,
} from '../src/agent/pending';
import {
  askSubscribeKeyword,
  handleKeywordReply,
  handlePendingReply,
} from '../src/wecom/pending';
import { sendWeComText } from '../src/wecom/api';
import type { InboundMessage } from '../src/wecom/router';

const NOW = new Date('2026-10-26T02:00:00Z');

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
  return vi.mocked(sendWeComText).mock.calls.at(-1)?.[1] ?? '';
}

beforeEach(() => {
  state.row = null;
  state.readError = false;
  state.writes = [];
  state.writeError = false;
  state.deletes = [];
  state.remembered = [];
  state.rememberStatus = 'added';
  state.profile = null;
  onboardingMock.handleSubscribe.mockClear();
  vi.mocked(sendWeComText).mockClear();
});

describe('interpretConfirmation', () => {
  it('确认词（含标点）→ confirm', () => {
    for (const text of ['对', '好', '好的', '是', '可以', '嗯', '对。']) {
      expect(interpretConfirmation(text)).toBe('confirm');
    }
  });

  it('否定词 → reject', () => {
    for (const text of ['不对', '不', '不用', '算了', '不。']) {
      expect(interpretConfirmation(text)).toBe('reject');
    }
  });

  it('其它内容 → null（按新消息处理）', () => {
    expect(interpretConfirmation('python 热榜')).toBeNull();
    expect(interpretConfirmation('')).toBeNull();
  });
});

describe('pending 存取', () => {
  it('写 5 分钟 TTL', async () => {
    const stored = await setPending('u1', { kind: 'profile-suggestion', fact: '我最近更喜欢 python', at: NOW.toISOString() }, NOW);
    expect(stored).toBe(true);
    expect(state.writes[0]?.key).toBe('pending:v1:u1');
    expect(state.writes[0]?.expiresAt.getTime()).toBe(NOW.getTime() + PENDING_TTL_MS);
  });

  it('过期 / 坏值 / 读失败 → null（当作没有待办）', async () => {
    state.row = {
      value: { kind: 'profile-suggestion', fact: 'x', at: NOW.toISOString() },
      expiresAt: new Date(NOW.getTime() - 1),
    };
    expect(await readPending('u1', NOW)).toBeNull();

    state.row = { value: { kind: 'nope' }, expiresAt: new Date(NOW.getTime() + 1000) };
    expect(await readPending('u1', NOW)).toBeNull();

    state.readError = true;
    expect(await readPending('u1', NOW)).toBeNull();
  });

  it('清空 → 删除整行', async () => {
    await clearPending('u1');
    expect(state.deletes).toEqual(['pending:v1:u1']);
  });
});

describe('建议文案', () => {
  it('只写有信号的方向；双向都有时一句话说清', () => {
    expect(buildSuggestionFact({ more: ['python'], less: ['rust'] })).toBe(
      '我最近更喜欢 python，少看 rust',
    );
    expect(buildSuggestionFact({ more: [], less: [] })).toBe('');
  });

  it('提示用「回一个字」，并给退出方式', () => {
    const text = suggestionText('我最近更喜欢 python');
    expect(text).toContain('我最近更喜欢 python');
    expect(text).toContain('回「对」');
    expect(text).toContain('回「不」');
  });
});

describe('handlePendingReply', () => {
  it('确认 → 写记忆并回执', async () => {
    await handlePendingReply(
      message('对'),
      { kind: 'profile-suggestion', fact: '我最近更喜欢 python', at: NOW.toISOString() },
      'confirm',
    );
    expect(state.remembered).toEqual(['我最近更喜欢 python']);
    expect(sent()).toContain('✅ 记住了：我最近更喜欢 python');
    expect(state.deletes).toContain('pending:v1:u1');
  });

  it('拒绝 → 不写库，说明随时可以手动记', async () => {
    await handlePendingReply(
      message('不'),
      { kind: 'profile-suggestion', fact: '我最近更喜欢 python', at: NOW.toISOString() },
      'reject',
    );
    expect(state.remembered).toEqual([]);
    expect(sent()).toContain('不记了');
    expect(sent()).toContain('记住');
  });

  it('写记忆失败 → 如实说没记住', async () => {
    state.rememberStatus = 'error';
    await handlePendingReply(
      message('对'),
      { kind: 'profile-suggestion', fact: 'x', at: NOW.toISOString() },
      'confirm',
    );
    expect(sent()).toContain('没记住');
  });
});

describe('订阅缺槽追问', () => {
  it('一个词/逗号分隔多个词 → 关键词；带空格、空串、过长 → null（按新消息处理）', () => {
    expect(interpretKeyword('python')).toBe('python');
    expect(interpretKeyword('python,ai')).toBe('python,ai');
    expect(interpretKeyword('  python。 ')).toBe('python');
    expect(interpretKeyword('python 热榜')).toBeNull();
    expect(interpretKeyword('')).toBeNull();
    expect(interpretKeyword('a'.repeat(41))).toBeNull();
  });

  it('裸「订阅」→ 追问一句，并落下单槽待办', async () => {
    await askSubscribeKeyword(message('订阅'));

    expect(sent()).toContain('想订阅什么');
    expect(state.writes[0]).toMatchObject({
      key: 'pending:v1:u1',
      value: { kind: 'subscribe-keyword' },
    });
  });

  it('待办写失败 → 不假装在等回复，让用户直接发完整命令', async () => {
    state.writeError = true;

    await askSubscribeKeyword(message('订阅'));

    expect(sent()).toContain('没设上');
    expect(sent()).toContain('订阅 <词>');
  });

  it('关键词回复 → 先清待办，再走真实订阅处理器（不复制一套写库逻辑）', async () => {
    await handleKeywordReply(message('python'), 'python');

    expect(state.deletes).toContain('pending:v1:u1');
    expect(onboardingMock.handleSubscribe).toHaveBeenCalledTimes(1);
    expect(onboardingMock.handleSubscribe.mock.calls[0]?.[0]).toMatchObject({
      fromUserName: 'u1',
      content: '订阅 python',
    });
  });
});
