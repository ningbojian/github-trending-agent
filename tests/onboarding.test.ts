import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 13：订阅开通（首条消息 onboarding）与 订阅/退订 偏好命令。
 * 所有 DB 与企微发送均 mock —— 绝不触网、不连库。
 */

// ---------------------------------------------------------------------------
// Mocks：sendWeComText / db 层
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

const dbMock = vi.hoisted(() => ({
  /** select 队列：每次 await select 链弹出一项；Error 实例表示该次查询失败。 */
  selectQueue: [] as unknown[],
  selectCalls: [] as { table: unknown; condition: unknown }[],
  insertCalls: [] as { table: unknown; values: Record<string, unknown> }[],
  insertError: undefined as Error | undefined,
  updateCalls: [] as {
    table: unknown;
    values: Record<string, unknown>;
    condition: unknown;
  }[],
}));

vi.mock('../src/db/client', () => {
  /** 可 await 的 select 流水线（模拟 drizzle thenable builder）。 */
  function selectPipeline() {
    const pipeline = {
      then: (
        onFulfilled?: (value: Record<string, unknown>[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        const next = dbMock.selectQueue.shift() ?? [];
        if (next instanceof Error) {
          return Promise.reject(next).then(onFulfilled, onRejected);
        }
        return Promise.resolve(next as Record<string, unknown>[]).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return pipeline;
  }

  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            dbMock.selectCalls.push({ table, condition });
            return selectPipeline();
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          dbMock.insertCalls.push({ table, values });
          if (dbMock.insertError) {
            return Promise.reject(dbMock.insertError);
          }
          return Promise.resolve();
        },
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async (condition: unknown) => {
            dbMock.updateCalls.push({ table, values, condition });
          },
        }),
      }),
    }),
  };
});

import { subscribers } from '../src/db/schema';
import {
  ensureSubscriber,
  handleHelp,
  handleSubscribe,
  handleUnsubscribe,
  HELP_MESSAGE,
  WELCOME_MESSAGE,
} from '../src/wecom/onboarding';
import {
  registerHandlers,
  resetHandlers,
  routeMessage,
  type InboundMessage,
} from '../src/wecom/router';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function compileQuery(wrapper: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(wrapper as SQL);
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'gh_agent',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'text',
    content: 'python 热榜',
    msgId: '4001',
    ...overrides,
  };
}

/** 已开通的订阅者行（老用户）。 */
function existingSub(): Record<string, unknown> {
  return {
    wecomUserid: 'alice',
    active: true,
    preferences: { languages: [], keywords: [] },
  };
}

const helpHandler = vi.fn();
const unfavoriteHandler = vi.fn();
const favoriteHandler = vi.fn();
const listHandler = vi.fn();
const bindHandlerMock = vi.fn();
const searchHandler = vi.fn();
const subscribeHandler = vi.fn();
const unsubscribeHandler = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectQueue.length = 0;
  dbMock.selectCalls.length = 0;
  dbMock.insertCalls.length = 0;
  dbMock.insertError = undefined;
  dbMock.updateCalls.length = 0;
  apiMock.sendWeComText.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // 全量替换为 mock handler：真实 search/bind/stars handler 绝不触发。
  resetHandlers();
  registerHandlers({
    help: helpHandler,
    unfavorite: unfavoriteHandler,
    favorite: favoriteHandler,
    list: listHandler,
    bind: bindHandlerMock,
    search: searchHandler,
    subscribe: subscribeHandler,
    unsubscribe: unsubscribeHandler,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ensureSubscriber —— 新用户自动开通
// ---------------------------------------------------------------------------
describe('ensureSubscriber — 新用户自动开通', () => {
  it('无订阅者行 → insert（active=true、空偏好）并返回 true', async () => {
    dbMock.selectQueue.push([]);

    await expect(ensureSubscriber(makeMsg())).resolves.toBe(true);

    expect(dbMock.selectCalls).toHaveLength(1);
    expect(dbMock.selectCalls[0]?.table).toBe(subscribers);
    const compiled = compileQuery(dbMock.selectCalls[0]?.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');

    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.table).toBe(subscribers);
    expect(dbMock.insertCalls[0]?.values).toMatchObject({
      wecomUserid: 'alice',
      active: true,
      preferences: { languages: [], keywords: [] },
    });
  });

  it('已有订阅者行 → 不 insert，返回 false（老用户）', async () => {
    dbMock.selectQueue.push([existingSub()]);

    await expect(ensureSubscriber(makeMsg())).resolves.toBe(false);

    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('查询失败（DB 错误）→ log warn 并返回 false，不向外抛（fail-open）', async () => {
    dbMock.selectQueue.push(new Error('db down'));

    await expect(ensureSubscriber(makeMsg())).resolves.toBe(false);

    expect(console.warn).toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 首条消息：欢迎语
// ---------------------------------------------------------------------------
describe('首条消息 onboarding — 欢迎语', () => {
  it('新用户首条消息 → insert + 先发欢迎语，再继续处理原消息（欢迎语在前）', async () => {
    dbMock.selectQueue.push([]);
    const search = vi.fn(async (msg: InboundMessage) => {
      await apiMock.sendWeComText(msg.fromUserName, '（搜索结果）');
    });
    registerHandlers({ search });

    await routeMessage(makeMsg({ content: 'python 热榜' }));

    expect(dbMock.insertCalls).toHaveLength(1);
    expect(dbMock.insertCalls[0]?.values).toMatchObject({
      wecomUserid: 'alice',
      active: true,
      preferences: { languages: [], keywords: [] },
    });

    // 两条回复：欢迎语在前，原消息处理回复在后。
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    const calls = apiMock.sendWeComText.mock.calls as [string, string][];
    expect(calls[0]).toEqual(['alice', WELCOME_MESSAGE]);
    expect(calls[1]).toEqual(['alice', '（搜索结果）']);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('老用户 → 不 insert、不重复欢迎，原消息照常路由', async () => {
    dbMock.selectQueue.push([existingSub()]);
    registerHandlers({ search: searchHandler });

    await routeMessage(makeMsg({ content: 'python 热榜' }));

    expect(dbMock.selectCalls).toHaveLength(1);
    expect(dbMock.insertCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(searchHandler).toHaveBeenCalledTimes(1);
  });

  it('insert 失败（DB 错误）→ log warn、不发欢迎语，原消息照常路由（fail-open，不 dead-letter 聊天）', async () => {
    dbMock.selectQueue.push([]);
    dbMock.insertError = new Error('unique violation');

    await expect(
      routeMessage(makeMsg({ content: 'python 热榜' })),
    ).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalled();
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(searchHandler).toHaveBeenCalledTimes(1);
  });

  it('非文本消息（image）→ 不触发 ensureSubscriber（无 DB 访问）、静默忽略', async () => {
    await routeMessage(makeMsg({ msgType: 'image', content: '' }));

    expect(dbMock.selectCalls).toHaveLength(0);
    expect(dbMock.insertCalls).toHaveLength(0);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('欢迎语为全中文功能说明：简报 / 搜索示例 / 绑定 / 订阅 / 退订', () => {
    expect(WELCOME_MESSAGE).toContain('简报');
    expect(WELCOME_MESSAGE).toContain('本周 python 的 ai 项目');
    expect(WELCOME_MESSAGE).toContain('绑定');
    expect(WELCOME_MESSAGE).toContain('订阅');
    expect(WELCOME_MESSAGE).toContain('退订');
  });
});

// ---------------------------------------------------------------------------
// 订阅命令
// ---------------------------------------------------------------------------
describe('handleSubscribe（订阅 <偏好> → 写 preferences）', () => {
  it('「订阅 python, ai、llm」→ preferences 整体替换为 { languages: [], keywords: [...] } 并确认', async () => {
    await handleSubscribe(makeMsg({ content: '订阅 python, ai、llm' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    const update = dbMock.updateCalls[0]!;
    expect(update.table).toBe(subscribers);
    expect(update.values).toMatchObject({
      preferences: { languages: [], keywords: ['python', 'ai', 'llm'] },
    });
    const compiled = compileQuery(update.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('已订阅');
    expect(content).toContain('python');
    expect(content).toContain('ai');
    expect(content).toContain('llm');
  });

  it('退订后再订阅（active=false + 旧偏好）→ 同时写 preferences 与 active: true，恢复每日简报', async () => {
    // 场景：先「退订」（handleUnsubscribe 写 active=false，见下方退订 describe），
    // 再「订阅 python,ai」——README/HELP/UNSUBSCRIBE_REPLY 均承诺可随时重新订阅，
    // 若 update 只写 preferences，active 仍为 false，简报永远恢复不了。
    await handleSubscribe(makeMsg({ content: '订阅 python,ai' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    const update = dbMock.updateCalls[0]!;
    expect(update.table).toBe(subscribers);
    expect(update.values).toEqual({
      preferences: { languages: [], keywords: ['python', 'ai'] },
      active: true,
    });
    const compiled = compileQuery(update.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');

    // 确认回执照常发出（老用户订阅路径的其他行为不受影响）。
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('已订阅');
    expect(content).toContain('python');
    expect(content).toContain('ai');
  });

  it('分隔符规则：中英文逗号、顿号、空格混合 + 多余空白 → 全部拆分并 trim', async () => {
    await handleSubscribe(makeMsg({ content: '订阅 python，rust、 go,,  web' }));

    const update = dbMock.updateCalls[0]!;
    expect(update.values).toMatchObject({
      preferences: { languages: [], keywords: ['python', 'rust', 'go', 'web'] },
    });
  });

  it('裸「订阅」（无可解析关键词）→ 用法提示，不写库', async () => {
    await handleSubscribe(makeMsg({ content: '订阅' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('用法');
    expect(content).toContain('订阅');
  });

  it('重复订阅整体覆盖：第二次「订阅 llm」→ keywords 只剩 llm、languages 重置为空', async () => {
    await handleSubscribe(makeMsg({ content: '订阅 ai,agent' }));
    await handleSubscribe(makeMsg({ content: '订阅 llm' }));

    expect(dbMock.updateCalls).toHaveLength(2);
    expect(dbMock.updateCalls[1]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['llm'] },
    });
  });

  it('非「订阅」开头的内容直接调用 → 静默返回，不写库不回复', async () => {
    await handleSubscribe(makeMsg({ content: '我想订阅说明' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('router：「订阅 python」→ subscribe handler（不落 search 兜底）', async () => {
    dbMock.selectQueue.push([existingSub()]);

    await routeMessage(makeMsg({ content: '订阅 python' }));

    expect(subscribeHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
    expect(subscribeHandler.mock.calls[0]?.[0]).toMatchObject({
      content: '订阅 python',
    });
  });
});

// ---------------------------------------------------------------------------
// 退订命令
// ---------------------------------------------------------------------------
describe('handleUnsubscribe（退订 → active=false）', () => {
  it('「退订」→ 写 active=false（仅此字段）+ 中文确认，不触碰绑定/收藏/偏好', async () => {
    await handleUnsubscribe(makeMsg({ content: '退订' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    const update = dbMock.updateCalls[0]!;
    expect(update.table).toBe(subscribers);
    expect(update.values).toEqual({ active: false });
    const compiled = compileQuery(update.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('退订');
    expect(content).toContain('不再推送');
  });

  it('「退订」为精确匹配：其他内容直接调用 → 静默返回，不写库不回复', async () => {
    await handleUnsubscribe(makeMsg({ content: '退订说明' }));
    await handleUnsubscribe(makeMsg({ content: '我要退订' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('router：「退订」→ unsubscribe handler，不被「订阅」前缀吞掉', async () => {
    dbMock.selectQueue.push([existingSub()]);

    await routeMessage(makeMsg({ content: '退订' }));

    expect(unsubscribeHandler).toHaveBeenCalledTimes(1);
    expect(subscribeHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('退订写 active=false + 按 wecom_userid 定位（配合 digest 已固化的 active=true 过滤 → 该用户被 pushDigests 跳过）', async () => {
    dbMock.selectQueue.push([existingSub()]);
    // 走完整链路：router「退订」→ 真实 handleUnsubscribe → 写库。
    resetHandlers();
    registerHandlers({ unsubscribe: handleUnsubscribe });

    await routeMessage(makeMsg({ content: '退订' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    const update = dbMock.updateCalls[0]!;
    expect(update.table).toBe(subscribers);
    expect(update.values).toEqual({ active: false });
    const compiled = compileQuery(update.condition);
    expect(compiled.sql).toContain('"subscribers"."wecom_userid"');
    expect(compiled.params).toContain('alice');
    // digest.ts 的 pushDigests 固化 WHERE active = true（tests/digest.test.ts 已钉），
    // active=false 写入后该订阅者即被排除。
  });
});

// ---------------------------------------------------------------------------
// 帮助命令
// ---------------------------------------------------------------------------
describe('handleHelp（帮助 → 完整用法说明）', () => {
  it('老用户发「帮助」→ 只发帮助文案（覆盖全部用户指令；无欢迎语、无其他 handler、无写库）', async () => {
    dbMock.selectQueue.push([existingSub()]);
    // 挂接真实 help handler（其余 handler 保持 mock，绝不触发真实实现）。
    registerHandlers({ help: handleHelp });

    await routeMessage(makeMsg({ content: '帮助' }));

    // 恰好一条回复：发给发送者的帮助文案（老用户路径，无欢迎语）。
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [to, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(to).toBe('alice');
    expect(content).toBe(HELP_MESSAGE);
    // 帮助文案为全中文，覆盖全部用户指令。
    expect(content).toContain('自然语言搜索');
    expect(content).toContain('本周 python 的 ai 项目');
    expect(content).toContain('收藏 N');
    expect(content).toContain('取消收藏 N');
    expect(content).toContain('我的收藏');
    expect(content).toContain('绑定');
    expect(content).toContain('订阅 <偏好>');
    expect(content).toContain('退订');

    // 老用户路径：ensureSubscriber 只 select，不 insert；帮助不写任何库表。
    expect(dbMock.selectCalls).toHaveLength(1);
    expect(dbMock.insertCalls).toHaveLength(0);
    expect(dbMock.updateCalls).toHaveLength(0);

    // 其余 handler 一律未被调用。
    expect(helpHandler).not.toHaveBeenCalled();
    expect(unfavoriteHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(listHandler).not.toHaveBeenCalled();
    expect(bindHandlerMock).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
    expect(subscribeHandler).not.toHaveBeenCalled();
    expect(unsubscribeHandler).not.toHaveBeenCalled();
  });

  it('「帮助」为精确匹配：「帮助中心」「帮」不触发 help，落入 search 兜底', async () => {
    dbMock.selectQueue.push([existingSub()], [existingSub()]);

    await routeMessage(makeMsg({ content: '帮助中心' }));
    await routeMessage(makeMsg({ content: '帮' }));

    expect(helpHandler).not.toHaveBeenCalled();
    expect(searchHandler).toHaveBeenCalledTimes(2);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });
});
