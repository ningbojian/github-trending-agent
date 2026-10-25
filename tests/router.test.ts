import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendWeComText } from '../src/wecom/api';
import {
  registerHandlers,
  resetHandlers,
  routeMessage,
  type InboundMessage,
} from '../src/wecom/router';

vi.mock('../src/wecom/api', () => ({
  sendWeComText: vi.fn(),
}));

/**
 * Task 6：router 在分发前调用 ensureSubscriber / sendWelcomeFlow。
 * 这里只替换这两个协作者，其余 onboarding 导出（各 handler）保持真实实现——
 * 测试用 registerHandlers 覆盖具体 handler，不依赖它们的行为。
 * 未 mock 时 ensureSubscriber 会真的连库（config 缺失 → warn），测试被噪音淹没。
 */
const subscribeFlowMock = vi.hoisted(() => ({
  ensureSubscriber: vi.fn(),
  sendWelcomeFlow: vi.fn(),
}));

vi.mock('../src/wecom/onboarding', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/wecom/onboarding')>();
  return { ...actual, ensureSubscriber: subscribeFlowMock.ensureSubscriber };
});

// onboarding 会 `export { WELCOME_MESSAGE } from './welcome.js'`；
// mock 里补上该导出，避免 re-export 绑定在 mock 模块上解析失败。
vi.mock('../src/wecom/welcome', () => ({
  sendWelcomeFlow: subscribeFlowMock.sendWelcomeFlow,
  WELCOME_MESSAGE: '欢迎',
}));

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'gh_agent',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'text',
    content: 'python 热榜',
    msgId: '1001',
    ...overrides,
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
const digestCountHandler = vi.fn();
const pushTimeHandler = vi.fn();
const pushIntervalHandler = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWeComText).mockReset();
  vi.mocked(sendWeComText).mockResolvedValue(undefined);
  // 默认按老用户处理：事件静默、文本不触发送礼包流程。
  subscribeFlowMock.ensureSubscriber.mockReset();
  subscribeFlowMock.ensureSubscriber.mockResolvedValue(false);
  subscribeFlowMock.sendWelcomeFlow.mockReset();
  subscribeFlowMock.sendWelcomeFlow.mockResolvedValue(undefined);
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
    digestCount: digestCountHandler,
    pushTime: pushTimeHandler,
    pushInterval: pushIntervalHandler,
  });
});

describe('routeMessage 分发', () => {
  it('content 为「帮助」→ helpHandler', async () => {
    await routeMessage(makeMsg({ content: '帮助' }));
    expect(helpHandler).toHaveBeenCalledTimes(1);
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('content 为「收藏 1」→ favoriteHandler', async () => {
    await routeMessage(makeMsg({ content: '收藏 1' }));
    expect(favoriteHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
    expect(helpHandler).not.toHaveBeenCalled();
  });

  it('content 为「收藏12」（无空格、多位数）→ favoriteHandler', async () => {
    await routeMessage(makeMsg({ content: '收藏12' }));
    expect(favoriteHandler).toHaveBeenCalledTimes(1);
  });

  it('「收藏」后跟非数字（如「收藏夹怎么用」）→ 回收藏用法提示，不落搜索/收藏 handler', async () => {
    await routeMessage(makeMsg({ content: '收藏夹怎么用' }));
    expect(sendWeComText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWeComText).mock.calls[0]?.[1]).toBe(
      '用法：「收藏 N」，N 为 1 起的数字，例如：收藏 1',
    );
    expect(searchHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
  });

  it('其他文本 → searchHandler', async () => {
    await routeMessage(makeMsg({ content: 'rust 框架' }));
    expect(searchHandler).toHaveBeenCalledTimes(1);
    expect(helpHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
  });

  it('非文本消息（image）静默忽略，不触发任何 handler', async () => {
    await routeMessage(makeMsg({ msgType: 'image', content: '' }));
    expect(helpHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('非文本、非 enter_agent 的事件静默忽略', async () => {
    await routeMessage(
      makeMsg({ msgType: 'event', event: 'change_contact', content: '<xml/>' }),
    );
    expect(searchHandler).not.toHaveBeenCalled();
    expect(subscribeFlowMock.ensureSubscriber).not.toHaveBeenCalled();
  });

  it('handler 可被后续注册覆盖（Task 9/12/13 插桩机制）', async () => {
    const replacement = vi.fn();
    registerHandlers({ search: replacement });
    await routeMessage(makeMsg({ content: 'go web 框架' }));
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });
});

describe('enter_agent 事件 —— 加入即自动收到简报', () => {
  it('新用户进入应用 → 建订阅者行并送出礼包（欢迎 + 首日简报）', async () => {
    subscribeFlowMock.ensureSubscriber.mockResolvedValue(true);

    await routeMessage(
      makeMsg({ msgType: 'event', event: 'enter_agent', content: '' }),
    );

    expect(subscribeFlowMock.ensureSubscriber).toHaveBeenCalledTimes(1);
    expect(subscribeFlowMock.sendWelcomeFlow).toHaveBeenCalledTimes(1);
    expect(subscribeFlowMock.sendWelcomeFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUserName: 'alice',
        msgType: 'event',
        event: 'enter_agent',
      }),
    );
    // 事件消息不进入文本分发：不搜索、不回帮助、不发用法提示。
    expect(searchHandler).not.toHaveBeenCalled();
    expect(helpHandler).not.toHaveBeenCalled();
    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('老用户进入应用 → 不再打扰（不送礼包、不发任何消息）', async () => {
    subscribeFlowMock.ensureSubscriber.mockResolvedValue(false);

    await routeMessage(
      makeMsg({ msgType: 'event', event: 'enter_agent', content: '' }),
    );

    expect(subscribeFlowMock.ensureSubscriber).toHaveBeenCalledTimes(1);
    expect(subscribeFlowMock.sendWelcomeFlow).not.toHaveBeenCalled();
    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('礼包流程抛错 → routeMessage 不 reject（fail-open，聊天分发不受影响）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeFlowMock.ensureSubscriber.mockResolvedValue(true);
    subscribeFlowMock.sendWelcomeFlow.mockRejectedValue(new Error('digest down'));

    await expect(
      routeMessage(
        makeMsg({ msgType: 'event', event: 'enter_agent', content: '' }),
      ),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'enter_agent handling failed:',
      expect.objectContaining({ message: 'digest down' }),
    );
    errorSpy.mockRestore();
  });

  it('首条 text（新用户）→ 先送礼包，再回复原消息（保证「收藏 N」指向用户最后看到的消息）', async () => {
    subscribeFlowMock.ensureSubscriber.mockResolvedValue(true);

    await routeMessage(makeMsg({ content: 'python 热榜' }));

    expect(subscribeFlowMock.sendWelcomeFlow).toHaveBeenCalledTimes(1);
    expect(searchHandler).toHaveBeenCalledTimes(1);
    const welcomeOrder =
      subscribeFlowMock.sendWelcomeFlow.mock.invocationCallOrder[0]!;
    const searchOrder = searchHandler.mock.invocationCallOrder[0]!;
    expect(welcomeOrder).toBeLessThan(searchOrder);
  });

  it('礼包发送失败 → 原消息照常分发（fail-open）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeFlowMock.ensureSubscriber.mockResolvedValue(true);
    subscribeFlowMock.sendWelcomeFlow.mockRejectedValue(new Error('send down'));

    await routeMessage(makeMsg({ content: 'python 热榜' }));

    expect(searchHandler).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('dispatchSafely — handler 异常兜底（用户零感知原则）', () => {
  it('handler 抛错：不 reject，单次回发兜底文案并记日志', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    searchHandler.mockRejectedValue(new Error('handler blew up'));

    await expect(
      routeMessage(makeMsg({ content: 'anything' })),
    ).resolves.toBeUndefined();

    expect(sendWeComText).toHaveBeenCalledTimes(1);
    expect(sendWeComText).toHaveBeenCalledWith(
      'alice',
      '⚙️ 处理遇到问题，请稍后再试',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'handler failed:',
      expect.objectContaining({ message: 'handler blew up' }),
    );
    errorSpy.mockRestore();
  });

  it('兜底 send 也失败：仅记日志、不重试不重入（递归护栏）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    searchHandler.mockRejectedValue(new Error('boom'));
    vi.mocked(sendWeComText).mockRejectedValue(new Error('send down'));

    await expect(
      routeMessage(makeMsg({ content: 'anything' })),
    ).resolves.toBeUndefined();

    // 只尝试一次兜底——绝不重试、绝不重入分发（防无限递归）。
    expect(sendWeComText).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'fallback reply failed:',
      expect.objectContaining({ message: 'send down' }),
    );
    errorSpy.mockRestore();
  });

  it('handler 成功：不发兜底', async () => {
    searchHandler.mockResolvedValue(undefined);

    await routeMessage(makeMsg({ content: 'anything' }));

    expect(sendWeComText).not.toHaveBeenCalled();
  });
});

describe('「条数 N」指令路由（前缀分发，用法校验在 handler 内）', () => {
  it('「条数 5」→ digestCountHandler，不落 search', async () => {
    const digestCountHandler = vi.fn();
    registerHandlers({ digestCount: digestCountHandler });

    await routeMessage(makeMsg({ content: '条数 5' }));

    expect(digestCountHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「条数」前缀任意后续内容都进 digestCountHandler（裸指令/非法由 handler 回用法提示）', async () => {
    const digestCountHandler = vi.fn();
    registerHandlers({ digestCount: digestCountHandler });

    await routeMessage(makeMsg({ content: '条数太多了' }));

    expect(digestCountHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });
});

describe('中文数字收藏路由（parseCnNumber 与正则同步）', () => {
  it('「收藏一」「收藏1」「收藏 十」→ favoriteHandler（中文数字与阿拉伯数字同权）', async () => {
    await routeMessage(makeMsg({ content: '收藏一' }));
    await routeMessage(makeMsg({ content: '收藏 1' }));
    await routeMessage(makeMsg({ content: '收藏 十' }));
    expect(favoriteHandler).toHaveBeenCalledTimes(3);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「收藏 0」→ 数字式匹配 → favoriteHandler（用法提示由 handler 回，不落搜索）', async () => {
    await routeMessage(makeMsg({ content: '收藏 0' }));
    expect(favoriteHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('「取消收藏二」→ unfavoriteHandler，不误入 favorite', async () => {
    await routeMessage(makeMsg({ content: '取消收藏二' }));
    expect(unfavoriteHandler).toHaveBeenCalledTimes(1);
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('尾标点容忍：「收藏 1。」→ favoriteHandler', async () => {
    await routeMessage(makeMsg({ content: '收藏 1。' }));
    expect(favoriteHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });
});

describe('疑似命令容错（命令写错不再掉进搜索）', () => {
  it('「收藏一下」「收藏第一条」→ 回收藏用法提示，不落搜索/收藏 handler', async () => {
    await routeMessage(makeMsg({ content: '收藏一下' }));
    await routeMessage(makeMsg({ content: '收藏第一条' }));
    expect(sendWeComText).toHaveBeenCalledTimes(2);
    for (const [, text] of vi.mocked(sendWeComText).mock.calls) {
      expect(text).toBe('用法：「收藏 N」，N 为 1 起的数字，例如：收藏 1');
    }
    expect(searchHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
  });

  it('「取消收藏」（无数字）→ 回取消收藏用法提示', async () => {
    await routeMessage(makeMsg({ content: '取消收藏' }));
    expect(sendWeComText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWeComText).mock.calls[0]?.[1]).toBe(
      '用法：「取消收藏 N」，N 为 1 起的数字，例如：取消收藏 1',
    );
    expect(searchHandler).not.toHaveBeenCalled();
    expect(unfavoriteHandler).not.toHaveBeenCalled();
  });

  it('「我的收藏列表」「我的收藏夹」→ 回「我的收藏」用法提示（无需参数）', async () => {
    await routeMessage(makeMsg({ content: '我的收藏列表' }));
    await routeMessage(makeMsg({ content: '我的收藏夹' }));
    expect(sendWeComText).toHaveBeenCalledTimes(2);
    for (const [, text] of vi.mocked(sendWeComText).mock.calls) {
      expect(text).toContain('我的收藏');
      expect(text).toContain('无需参数');
    }
    expect(searchHandler).not.toHaveBeenCalled();
    expect(listHandler).not.toHaveBeenCalled();
  });

  it('「绑定 GitHub」→ 回绑定用法提示（无需参数）', async () => {
    await routeMessage(makeMsg({ content: '绑定 GitHub' }));
    expect(sendWeComText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWeComText).mock.calls[0]?.[1]).toContain('绑定');
    expect(vi.mocked(sendWeComText).mock.calls[0]?.[1]).toContain('无需参数');
    expect(searchHandler).not.toHaveBeenCalled();
    expect(bindHandlerMock).not.toHaveBeenCalled();
  });

  it('「退订一下」→ 回退订用法提示（无需参数）', async () => {
    await routeMessage(makeMsg({ content: '退订一下' }));
    expect(sendWeComText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWeComText).mock.calls[0]?.[1]).toContain('退订');
    expect(vi.mocked(sendWeComText).mock.calls[0]?.[1]).toContain('无需参数');
    expect(searchHandler).not.toHaveBeenCalled();
    expect(unsubscribeHandler).not.toHaveBeenCalled();
  });

  it('「帮助」仅精确匹配（允许尾标点）：「帮助。」→ help；「帮助我找 python」「帮助中心」→ 搜索', async () => {
    await routeMessage(makeMsg({ content: '帮助。' }));
    expect(helpHandler).toHaveBeenCalledTimes(1);
    expect(sendWeComText).not.toHaveBeenCalled();

    await routeMessage(makeMsg({ content: '帮助我找 python' }));
    await routeMessage(makeMsg({ content: '帮助中心' }));
    expect(searchHandler).toHaveBeenCalledTimes(2);
    expect(helpHandler).toHaveBeenCalledTimes(1);
    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('「条数」「订阅」的用法提示由 handler 负责，router 不重复拦截（仍分发给对应 handler）', async () => {
    await routeMessage(makeMsg({ content: '条数太多了' }));
    await routeMessage(makeMsg({ content: '订阅一下' }));
    expect(searchHandler).not.toHaveBeenCalled();
    expect(sendWeComText).not.toHaveBeenCalled();
  });
});

describe('「推送时间」「每 N 天」指令路由（锚定分发，用法校验在 handler 内）', () => {
  it('「每天 9 点」「推送时间 21:30」「每天八点」→ pushTimeHandler，不落 search', async () => {
    await routeMessage(makeMsg({ content: '每天 9 点' }));
    await routeMessage(makeMsg({ content: '推送时间 21:30' }));
    await routeMessage(makeMsg({ content: '每天八点' }));

    expect(pushTimeHandler).toHaveBeenCalledTimes(3);
    expect(searchHandler).not.toHaveBeenCalled();
    expect(pushIntervalHandler).not.toHaveBeenCalled();
  });

  it('「每两天推送」「每 2 天」「每 30 天简报」→ pushIntervalHandler，不落 search', async () => {
    await routeMessage(makeMsg({ content: '每两天推送' }));
    await routeMessage(makeMsg({ content: '每 2 天' }));
    await routeMessage(makeMsg({ content: '每 30 天简报' }));

    expect(pushIntervalHandler).toHaveBeenCalledTimes(3);
    expect(searchHandler).not.toHaveBeenCalled();
    expect(pushTimeHandler).not.toHaveBeenCalled();
  });

  it('strips a trailing period (手机键盘常带) before command matching', async () => {
    // 「每天 9 点.」「推送时间 20:30.」「每 2 天.」都不能掉进搜索。
    await routeMessage(makeMsg({ content: '每天 9 点.' }));
    await routeMessage(makeMsg({ content: '推送时间 20:30.' }));
    await routeMessage(makeMsg({ content: '每 2 天.' }));

    expect(pushTimeHandler).toHaveBeenCalledTimes(2);
    expect(pushIntervalHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('「每天 star 最多的项目」是合法搜索 → search，绝不进推送时间 handler', async () => {
    await routeMessage(makeMsg({ content: '每天 star 最多的项目' }));

    expect(searchHandler).toHaveBeenCalledTimes(1);
    expect(pushTimeHandler).not.toHaveBeenCalled();
    expect(sendWeComText).not.toHaveBeenCalled();
  });

  it('「每两天更新的项目」带后缀 → 锚定不命中，落 search', async () => {
    await routeMessage(makeMsg({ content: '每两天更新的项目' }));

    expect(searchHandler).toHaveBeenCalledTimes(1);
    expect(pushIntervalHandler).not.toHaveBeenCalled();
  });

  it('非法时间（「推送时间 25:99」）与裸「推送时间」→ 进 pushTimeHandler（用法提示由 handler 回）', async () => {
    await routeMessage(makeMsg({ content: '推送时间 25:99' }));
    await routeMessage(makeMsg({ content: '推送时间' }));

    expect(pushTimeHandler).toHaveBeenCalledTimes(2);
    expect(searchHandler).not.toHaveBeenCalled();
    // router 层不重复拦截（与「条数」一致：回执统一由 handler 负责）。
    expect(sendWeComText).not.toHaveBeenCalled();
  });
});

describe('默认 stub handlers（未注册时）', () => {
  it('不抛错、静默完成', async () => {
    resetHandlers();
    await expect(routeMessage(makeMsg({ content: '帮助' }))).resolves.toBeUndefined();
    await expect(routeMessage(makeMsg({ content: '收藏 3' }))).resolves.toBeUndefined();
    await expect(routeMessage(makeMsg({ content: '随便搜' }))).resolves.toBeUndefined();
  });
});
