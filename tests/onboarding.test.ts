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

// trace 会多写一次 kv_cache insert，与本文件的写库次数断言无关 → 只透传。
vi.mock('../src/obs/trace', () => ({
  withTrace: (_meta: unknown, fn: () => Promise<unknown>) => fn(),
  note: () => {},
  traceError: () => {},
}));

/**
 * 新用户礼包会真的去构建首日简报（Task 6 起 ensureSubscriber 之后的流程）。
 * 这里只替换礼包的三个副作用，其余 digest 导出（MAX_INTERVAL_DAYS 等）保持真实——
 * 否则本文件的 db mock 没有 execute()，简报会走失败降级分支，输出被错误日志污染。
 */
const digestMock = vi.hoisted(() => ({
  buildDigestWithEntries: vi.fn(),
  saveRecentResults: vi.fn(),
  markDigestSent: vi.fn(),
}));

vi.mock('../src/agent/digest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/digest')>();
  return { ...actual, ...digestMock };
});

// 首日礼包会记一条推送历史（垃圾数据也会进 kv_cache）。本文件只关心
// onboarding 自己写了什么，推送历史单独在 welcome.test.ts 覆盖。
vi.mock('../src/agent/push-history', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/agent/push-history')>();
  return { ...actual, recordPush: vi.fn(async () => undefined) };
});

// 多轮待办会让 router 每次多读一次 kv_cache；本文件只数 onboarding 自己的
// 读写次数，默认「没有待办」（细节见 pending.test.ts）。
vi.mock('../src/agent/pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/pending')>();
  return {
    ...actual,
    readPending: async () => null,
    clearPending: async () => undefined,
  };
});

vi.mock('../src/wecom/pending', () => ({
  handlePendingReply: async () => undefined,
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
  handleDigestCount,
  handleHelp,
  handlePushInterval,
  handlePushTime,
  handleSubscribe,
  handleUnsubscribe,
  HELP_MESSAGE,
  HELP_SHORT_MESSAGE,
  WELCOME_MESSAGE,
} from '../src/wecom/onboarding';
import {
  registerHandlers,
  resetHandlers,
  routeMessage,
  type InboundMessage,
} from '../src/wecom/router';
import { allowAllQuota } from './helpers/quota';

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
  allowAllQuota();
  dbMock.selectQueue.length = 0;
  dbMock.selectCalls.length = 0;
  dbMock.insertCalls.length = 0;
  dbMock.insertError = undefined;
  dbMock.updateCalls.length = 0;
  apiMock.sendWeComText.mockResolvedValue(undefined);
  // 礼包里的首日简报：固定一份最简结果，避免走真实 DB/摘要链路。
  digestMock.buildDigestWithEntries.mockReset();
  digestMock.buildDigestWithEntries.mockResolvedValue({
    content: '📊 今日 GitHub 热榜简报',
    entries: [{ fullName: 'a/one' }],
  });
  digestMock.saveRecentResults.mockReset();
  digestMock.saveRecentResults.mockResolvedValue(undefined);
  digestMock.markDigestSent.mockReset();
  digestMock.markDigestSent.mockResolvedValue(undefined);
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

    // 三条回复：欢迎语 → 首日简报 → 原消息处理回复（都在同一条 text 通道上）。
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(3);
    const calls = apiMock.sendWeComText.mock.calls as [string, string][];
    expect(calls[0]).toEqual(['alice', WELCOME_MESSAGE]);
    expect(calls[1]).toEqual(['alice', '📊 今日 GitHub 热榜简报']);
    expect(calls[2]).toEqual(['alice', '（搜索结果）']);
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

  it('欢迎语压缩到 3 行以内：身份/自动简报 + 示例 + 「帮助」入口（不再整屏说明书）', () => {
    const lines = WELCOME_MESSAGE.split('\n');
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toContain('GitHub 热榜助手');
    expect(WELCOME_MESSAGE).toContain('每日简报');
    expect(WELCOME_MESSAGE).toContain('本周 python 的 ai 项目');
    expect(WELCOME_MESSAGE).toContain('帮助');
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

  it('分隔符含中文句读（。！？；）与英文标点（!?;）：全部拆分为独立关键词', async () => {
    await handleSubscribe(makeMsg({ content: '订阅 python。ai！llm；rust' }));
    await handleSubscribe(makeMsg({ content: '订阅 go!?web;cli' }));

    expect(dbMock.updateCalls).toHaveLength(2);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['python', 'ai', 'llm', 'rust'] },
    });
    expect(dbMock.updateCalls[1]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['go', 'web', 'cli'] },
    });
  });

  it('「订阅 AI。」→ keywords=[AI]（尾标点不再混进关键词，修复线上 "AI。"）', async () => {
    await handleSubscribe(makeMsg({ content: '订阅 AI。' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['AI'] },
    });
  });

  it('token 内中英文括号等标点被剔除（与 parse-query 同一字符集），空串丢弃', async () => {
    await handleSubscribe(makeMsg({ content: '订阅 node（生态）、(cli) 。  ' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['node生态', 'cli'] },
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

  it('确认发送失败且兜底也失败 → 记两条日志，不向上传播', async () => {
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    await expect(
      handleSubscribe(makeMsg({ content: '订阅 python' })),
    ).resolves.toBeUndefined();

    expect(dbMock.updateCalls).toHaveLength(1); // 写库已完成，仅发送失败
    expect(console.error).toHaveBeenCalledWith(
      'handleSubscribe failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
    expect(console.error).toHaveBeenCalledWith(
      'subscribe fallback reply failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
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

  it('「订阅 python」读-合并-写：原 pushTime / intervalDays 保留，不被订阅指令清掉', async () => {
    dbMock.selectQueue.push([
      {
        wecomUserid: 'alice',
        active: true,
        preferences: {
          languages: [],
          keywords: ['ai'],
          digestCount: 7,
          pushTime: '21:30',
          intervalDays: 2,
        },
      },
    ]);

    await handleSubscribe(makeMsg({ content: '订阅 python' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: {
        languages: [],
        keywords: ['python'],
        digestCount: 7,
        pushTime: '21:30',
        intervalDays: 2,
      },
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

  it('确认发送失败且兜底也失败 → 记两条日志，不向上传播', async () => {
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    await expect(
      handleUnsubscribe(makeMsg({ content: '退订' })),
    ).resolves.toBeUndefined();

    expect(dbMock.updateCalls).toHaveLength(1); // 写库已完成，仅发送失败
    expect(console.error).toHaveBeenCalledWith(
      'handleUnsubscribe failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
    expect(console.error).toHaveBeenCalledWith(
      'unsubscribe fallback reply failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
  });

  it('router：「退订」→ unsubscribe handler，不被「订阅」前缀吞掉', async () => {
    dbMock.selectQueue.push([existingSub()]);

    await routeMessage(makeMsg({ content: '退订' }));

    expect(unsubscribeHandler).toHaveBeenCalledTimes(1);
    expect(subscribeHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('端到端：「退订。」（尾标点）经真实 handleUnsubscribe 也写 active=false（router 归一化后不再静默）', async () => {
    dbMock.selectQueue.push([existingSub()]);
    resetHandlers();
    registerHandlers({ unsubscribe: handleUnsubscribe });

    await routeMessage(makeMsg({ content: '退订。' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toEqual({ active: false });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('已退订');
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
    expect(content).toBe(HELP_SHORT_MESSAGE);
    // 短菜单只放常用入口，完整清单用「帮助 全部」。
    expect(content).toContain('帮助 全部');
    expect(content).toContain('追踪');
    expect(content).toContain('我的面板');
    expect(content).toContain('收藏 3');
    expect(content).toContain('我的订阅');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(600);
    // 帮助菜单不带搜索结果页脚（避免噪音——它本身就是指令目录）。
    expect(content).not.toContain('💡');

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

  it('「帮助 全部」→ 完整指令清单', async () => {
    dbMock.selectQueue.push([existingSub()]);
    registerHandlers({ help: handleHelp });

    await routeMessage(makeMsg({ content: '帮助 全部' }));

    const content = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(content).toBe(HELP_MESSAGE);
    expect(content).toContain('收藏 N');
    expect(content).toContain('订阅 <偏好>');
    expect(content).toContain('条数 N');
    expect(content).toContain('不感兴趣 3');
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

// ---------------------------------------------------------------------------
// handleDigestCount（「条数 N」→ preferences.digestCount）+ 订阅保留 digestCount
// ---------------------------------------------------------------------------
describe('handleDigestCount（条数 N → 简报条数自定义）', () => {
  it('「条数 7」→ 写 digestCount=7，保留原 languages/keywords，确认回执', async () => {
    dbMock.selectQueue.push([
      {
        wecomUserid: 'alice',
        active: true,
        preferences: { languages: [], keywords: ['ai'], digestCount: 5 },
      },
    ]);

    await handleDigestCount(makeMsg({ content: '条数 7' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['ai'], digestCount: 7 },
    });
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      '✅ 每日简报条数已设为 7（1–8）',
    );
  });

  it('「条数 五」→ 中文数字同样接受，写 digestCount=5', async () => {
    dbMock.selectQueue.push([
      {
        wecomUserid: 'alice',
        active: true,
        preferences: { languages: [], keywords: [], digestCount: 8 },
      },
    ]);

    await handleDigestCount(makeMsg({ content: '条数 五' }));

    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], digestCount: 5 },
    });
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      '✅ 每日简报条数已设为 5（1–8）',
    );
  });

  it('「条数 0」「条数 9」「条数 99」「条数 abc」→ 用法提示，不写库', async () => {
    await handleDigestCount(makeMsg({ content: '条数 0' }));
    await handleDigestCount(makeMsg({ content: '条数 9' }));
    await handleDigestCount(makeMsg({ content: '条数 99' }));
    await handleDigestCount(makeMsg({ content: '条数 abc' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(4);
    for (const [, content] of apiMock.sendWeComText.mock.calls) {
      expect(content as string).toContain('用法');
      expect(content as string).toContain('条数 N');
    }
  });

  it('端到端：「条数 5。」（尾标点）经真实 handleDigestCount 也写 digestCount=5（router 归一化后不再误回用法）', async () => {
    // 第一行给 ensureSubscriber（老用户），第二行给 handleDigestCount 的读-合并-写。
    dbMock.selectQueue.push([existingSub()], [existingSub()]);
    resetHandlers();
    registerHandlers({ digestCount: handleDigestCount });

    await routeMessage(makeMsg({ content: '条数 5。' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], digestCount: 5 },
    });
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      '✅ 每日简报条数已设为 5（1–8）',
    );
  });

  it('「订阅 python」读-合并-写：原 digestCount 保留，keywords 整体替换', async () => {
    dbMock.selectQueue.push([
      {
        wecomUserid: 'alice',
        active: false,
        preferences: { languages: [], keywords: ['ai'], digestCount: 7 },
      },
    ]);

    await handleSubscribe(makeMsg({ content: '订阅 python' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: ['python'], digestCount: 7 },
      active: true,
    });
  });
});

// ---------------------------------------------------------------------------
// handlePushTime（「每天 H 点」/「推送时间 HH:MM」→ preferences.pushTime）
// ---------------------------------------------------------------------------
describe('handlePushTime（每天 H 点 / 推送时间 HH:MM → 简报推送时间）', () => {
  /** 老用户行（含待保留的其他偏好字段）。 */
  function subRow(preferences: Record<string, unknown>): Record<string, unknown> {
    return { wecomUserid: 'alice', active: true, preferences };
  }

  it('「每天 9 点」→ pushTime="09:00"，回执注明北京时间，保留 digestCount/intervalDays', async () => {
    dbMock.selectQueue.push([
      subRow({
        languages: [],
        keywords: ['ai'],
        digestCount: 5,
        intervalDays: 3,
      }),
    ]);

    await handlePushTime(makeMsg({ content: '每天 9 点' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.table).toBe(subscribers);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: {
        languages: [],
        keywords: ['ai'],
        digestCount: 5,
        intervalDays: 3,
        pushTime: '09:00',
      },
    });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('09:00');
    expect(content).toContain('北京时间');
  });

  it('「推送时间 21:30」→ pushTime="21:30"', async () => {
    dbMock.selectQueue.push([subRow({ languages: [], keywords: [] })]);

    await handlePushTime(makeMsg({ content: '推送时间 21:30' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], pushTime: '21:30' },
    });
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('21:30');
    expect(content).toContain('北京时间');
  });

  it('「每天八点」（中文数字、无空格）→ pushTime="08:00"', async () => {
    dbMock.selectQueue.push([subRow({ languages: [], keywords: [] })]);

    await handlePushTime(makeMsg({ content: '每天八点' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], pushTime: '08:00' },
    });
  });

  it('「推送时间 25:99」（越界）→ 用法提示，不写库', async () => {
    await handlePushTime(makeMsg({ content: '推送时间 25:99' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(dbMock.selectCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('用法');
    expect(content).toContain('推送时间');
    expect(content).toContain('北京时间');
  });

  it('裸「推送时间」/ 裸「每天」（无时间）→ 用法提示，不写库', async () => {
    await handlePushTime(makeMsg({ content: '推送时间' }));
    await handlePushTime(makeMsg({ content: '每天' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    for (const [, content] of apiMock.sendWeComText.mock.calls) {
      expect(content as string).toContain('用法');
    }
  });

  it('端到端：「每天 9 点」经 router 分发到真实 handlePushTime（不落搜索）', async () => {
    // 第一行给 ensureSubscriber（老用户），第二行给 handler 的读-合并-写。
    dbMock.selectQueue.push([existingSub()], [existingSub()]);
    resetHandlers();
    registerHandlers({ pushTime: handlePushTime });

    await routeMessage(makeMsg({ content: '每天 9 点' }));

    expect(searchHandler).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], pushTime: '09:00' },
    });
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      expect.stringContaining('北京时间'),
    );
  });

  it('端到端：非法「推送时间 25:99」经 router → 用法提示，零 DB 写入', async () => {
    dbMock.selectQueue.push([existingSub()]);
    resetHandlers();
    registerHandlers({ pushTime: handlePushTime });

    await routeMessage(makeMsg({ content: '推送时间 25:99' }));

    expect(searchHandler).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('用法');
  });
});

// ---------------------------------------------------------------------------
// handlePushInterval（「每 N 天」→ preferences.intervalDays）
// ---------------------------------------------------------------------------
describe('handlePushInterval（每 N 天 → 简报推送间隔）', () => {
  function subRow(preferences: Record<string, unknown>): Record<string, unknown> {
    return { wecomUserid: 'alice', active: true, preferences };
  }

  it('「每 2 天」→ intervalDays=2，保留 pushTime/digestCount，回执含天数', async () => {
    dbMock.selectQueue.push([
      subRow({
        languages: [],
        keywords: ['ai'],
        digestCount: 5,
        pushTime: '21:30',
      }),
    ]);

    await handlePushInterval(makeMsg({ content: '每 2 天' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: {
        languages: [],
        keywords: ['ai'],
        digestCount: 5,
        pushTime: '21:30',
        intervalDays: 2,
      },
    });
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [string, string];
    expect(content).toContain('2');
    expect(content).toContain('天');
  });

  it('「每两天推送」（中文数字 + 尾缀）→ intervalDays=2', async () => {
    dbMock.selectQueue.push([subRow({ languages: [], keywords: [] })]);

    await handlePushInterval(makeMsg({ content: '每两天推送' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], intervalDays: 2 },
    });
  });

  it('「每 30 天简报」→ intervalDays=30（上限合法）', async () => {
    dbMock.selectQueue.push([subRow({ languages: [], keywords: [] })]);

    await handlePushInterval(makeMsg({ content: '每 30 天简报' }));

    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], intervalDays: 30 },
    });
  });

  it('「每 31 天」「每 0 天」「每两天半」→ 用法提示，不写库', async () => {
    await handlePushInterval(makeMsg({ content: '每 31 天' }));
    await handlePushInterval(makeMsg({ content: '每 0 天' }));
    await handlePushInterval(makeMsg({ content: '每两天半' }));

    expect(dbMock.updateCalls).toHaveLength(0);
    expect(dbMock.selectCalls).toHaveLength(0);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(3);
    for (const [, content] of apiMock.sendWeComText.mock.calls) {
      expect(content as string).toContain('用法');
      expect(content as string).toContain('1–30');
    }
  });

  it('端到端：「每两天」经 router 分发到真实 handlePushInterval（不落搜索）', async () => {
    dbMock.selectQueue.push([existingSub()], [existingSub()]);
    resetHandlers();
    registerHandlers({ pushInterval: handlePushInterval });

    await routeMessage(makeMsg({ content: '每两天' }));

    expect(searchHandler).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toHaveLength(1);
    expect(dbMock.updateCalls[0]?.values).toMatchObject({
      preferences: { languages: [], keywords: [], intervalDays: 2 },
    });
  });
});

// ---------------------------------------------------------------------------
// HELP_MESSAGE —— Task 5 新增两条指令（北京时间 / 1–30 天）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// HELP_MESSAGE —— 口味反馈（感兴趣 / 不感兴趣）
// ---------------------------------------------------------------------------
describe('HELP_MESSAGE —— 口味反馈', () => {
  it('含「感兴趣」「不感兴趣」两种说法，且说明连提两次才生效', () => {
    const line = HELP_MESSAGE.split('\n').find((l) => l.includes('感兴趣'));
    expect(line).toBeDefined();
    expect(line).toContain('不感兴趣');
    expect(line).toContain('两次');
  });

  it('整条帮助仍低于 1900 字节（企微 text 上限 2048，项目自留余量）', () => {
    expect(Buffer.byteLength(HELP_MESSAGE, 'utf8')).toBeLessThan(1900);
  });
});

describe('HELP_MESSAGE —— 推送时间与推送间隔', () => {
  it('含「推送时间」行（注明北京时间与示例）', () => {
    const line = HELP_MESSAGE.split('\n').find((l) => l.includes('推送时间'));
    expect(line).toBeDefined();
    expect(line).toContain('北京时间');
    expect(line).toContain('每天');
    expect(line).toContain('HH:MM');
  });

  it('含「推送间隔」行（注明 1–30 天范围与示例）', () => {
    const line = HELP_MESSAGE.split('\n').find((l) => l.includes('每 N 天'));
    expect(line).toBeDefined();
    expect(line).toContain('1–30');
    expect(line).toContain('每天');
  });

  it('说明简报加入即自动开通（默认每天 09:00），并区分搜索条数是「前 N 个」', () => {
    const digestLine = HELP_MESSAGE.split('\n').find((l) =>
      l.includes('每日简报'),
    );
    expect(digestLine).toBeDefined();
    expect(digestLine).toContain('自动');
    expect(digestLine).toContain('09:00');

    const searchLine = HELP_MESSAGE.split('\n').find((l) =>
      l.includes('自然语言搜索'),
    );
    expect(searchLine).toBeDefined();
    expect(searchLine).toContain('前');

    // 注意：搜索行也含「条数」（「条数用「前 5 个」控制」），必须用命令行的
    // 「条数：」冒号锚定，否则 find 会先命中搜索行。
    const countLine = HELP_MESSAGE.split('\n').find((l) =>
      l.includes('条数：'),
    );
    expect(countLine).toBeDefined();
    expect(countLine).toContain('简报');
  });
});
