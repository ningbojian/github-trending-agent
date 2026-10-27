import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「记住 / 忘掉 / 我的记忆」：命令解析与中文回执。
 * 存储读写整块替换——这里验的是「用户看到什么、什么时候不写库」。
 */

const state = vi.hoisted(() => ({
  profile: null as null | { facts: string[]; updatedAt: string },
  remembered: [] as string[],
  forgotten: [] as string[],
  forgetAllCalls: 0,
  rememberStatus: 'added' as 'added' | 'duplicate' | 'full' | 'error',
  forgetResult: [] as string[],
  forgetAllOk: true,
}));

vi.mock('../src/agent/profile', () => ({
  PROFILE_MAX_FACTS: 20,
  readProfile: async () => state.profile,
  rememberFact: async (_userid: string, fact: string) => {
    state.remembered.push(fact);
    return state.rememberStatus;
  },
  forgetFacts: async (_userid: string, term: string) => {
    state.forgotten.push(term);
    return state.forgetResult;
  },
  forgetAll: async () => {
    state.forgetAllCalls += 1;
    return state.forgetAllOk;
  },
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: vi.fn(async () => undefined),
}));

import { sendWeComText } from '../src/wecom/api';
import { decideTextRoute } from '../src/wecom/route-decision';
import {
  MEMORY_ERROR_REPLY,
  handleMemoryCommand,
  parseMemoryCommand,
} from '../src/wecom/memory';
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
  return vi.mocked(sendWeComText).mock.calls.at(-1)?.[1] ?? '';
}

beforeEach(() => {
  state.profile = null;
  state.remembered = [];
  state.forgotten = [];
  state.forgetAllCalls = 0;
  state.rememberStatus = 'added';
  state.forgetResult = [];
  state.forgetAllOk = true;
  vi.mocked(sendWeComText).mockClear();
});

describe('parseMemoryCommand', () => {
  it('「记住 …」有/无空格都取到正文', () => {
    expect(parseMemoryCommand('记住 我主要做 Agent 开发')).toEqual({
      kind: 'remember',
      fact: '我主要做 Agent 开发',
    });
    expect(parseMemoryCommand('记住我主要做Agent开发')).toEqual({
      kind: 'remember',
      fact: '我主要做Agent开发',
    });
  });

  it('裸「记住」→ 空正文（handler 回用法）', () => {
    expect(parseMemoryCommand('记住')).toEqual({ kind: 'remember', fact: '' });
  });

  it('「忘掉 全部 / 所有 / 裸忘掉」→ 清空', () => {
    expect(parseMemoryCommand('忘掉 全部')).toEqual({ kind: 'forget', term: null });
    expect(parseMemoryCommand('忘掉所有')).toEqual({ kind: 'forget', term: null });
    expect(parseMemoryCommand('忘掉')).toEqual({ kind: 'forget', term: null });
  });

  it('「忘掉 <词>」→ 精确删除关键词', () => {
    expect(parseMemoryCommand('忘掉 Rust')).toEqual({ kind: 'forget', term: 'Rust' });
  });

  it('「我的记忆」→ 查看；其余文本不是记忆命令', () => {
    expect(parseMemoryCommand('我的记忆')).toEqual({ kind: 'show' });
    expect(parseMemoryCommand('python 热榜')).toBeNull();
  });
});

describe('路由', () => {
  it('三条记忆指令都路由到 memory', () => {
    for (const text of ['记住 我是做 Agent 的', '忘掉 Rust', '我的记忆']) {
      expect(decideTextRoute(text)).toEqual({ kind: 'handler', handler: 'memory' });
    }
  });

  it('「记住这个仓库」也不会被当成搜索（前缀即命令）', () => {
    expect(decideTextRoute('记住这个仓库 astral-sh/ruff')).toEqual({
      kind: 'handler',
      handler: 'memory',
    });
  });
});

describe('handleMemoryCommand — 查看', () => {
  it('没有记忆 → 引导怎么记', async () => {
    await handleMemoryCommand(message('我的记忆'));
    expect(sent()).toContain('还没有记忆');
    expect(sent()).toContain('记住');
  });

  it('有记忆 → 编号列出，并说明怎么删', async () => {
    state.profile = {
      facts: ['我主要做 Agent 开发', '偏好 TypeScript'],
      updatedAt: '2026-10-27T00:00:00.000Z',
    };
    await handleMemoryCommand(message('我的记忆'));
    expect(sent()).toContain('1. 我主要做 Agent 开发');
    expect(sent()).toContain('2. 偏好 TypeScript');
    expect(sent()).toContain('忘掉');
  });
});

describe('handleMemoryCommand — 记住', () => {
  it('成功 → 回执点名这条', async () => {
    await handleMemoryCommand(message('记住 我主要做 Agent 开发'));
    expect(state.remembered).toEqual(['我主要做 Agent 开发']);
    expect(sent()).toContain('✅ 记住了：我主要做 Agent 开发');
  });

  it('重复 → 不假装新增', async () => {
    state.rememberStatus = 'duplicate';
    await handleMemoryCommand(message('记住 我主要做 Agent 开发'));
    expect(sent()).toContain('记忆里已经有了');
  });

  it('满了 → 告诉用户怎么腾位置', async () => {
    state.rememberStatus = 'full';
    await handleMemoryCommand(message('记住 再来一条'));
    expect(sent()).toContain('20');
    expect(sent()).toContain('忘掉');
  });

  it('正文为空 → 用法提示，不写库', async () => {
    await handleMemoryCommand(message('记住'));
    expect(state.remembered).toEqual([]);
    expect(sent()).toContain('要记住什么');
  });

  it('存储失败 → 明确说没记住（不能骗用户）', async () => {
    state.rememberStatus = 'error';
    await handleMemoryCommand(message('记住 x'));
    expect(sent()).toBe(MEMORY_ERROR_REPLY);
  });
});

describe('handleMemoryCommand — 忘掉', () => {
  it('命中 → 列出被删条目', async () => {
    state.forgetResult = ['喜欢 Rust'];
    await handleMemoryCommand(message('忘掉 Rust'));
    expect(state.forgotten).toEqual(['Rust']);
    expect(sent()).toContain('✅ 忘掉了：喜欢 Rust');
  });

  it('没命中 → 说清楚没找到，并给查看入口', async () => {
    await handleMemoryCommand(message('忘掉 Rust'));
    expect(sent()).toContain('没找到包含「Rust」的记忆');
    expect(sent()).toContain('我的记忆');
  });

  it('「忘掉 全部」→ 清空并确认', async () => {
    await handleMemoryCommand(message('忘掉 全部'));
    expect(state.forgetAllCalls).toBe(1);
    expect(sent()).toContain('已清空');
  });

  it('清空失败 → 错误文案', async () => {
    state.forgetAllOk = false;
    await handleMemoryCommand(message('忘掉 全部'));
    expect(sent()).toBe(MEMORY_ERROR_REPLY);
  });
});
