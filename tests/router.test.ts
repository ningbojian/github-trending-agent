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
const favoriteHandler = vi.fn();
const searchHandler = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWeComText).mockReset();
  vi.mocked(sendWeComText).mockResolvedValue(undefined);
  resetHandlers();
  registerHandlers({
    help: helpHandler,
    favorite: favoriteHandler,
    search: searchHandler,
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

  it('「收藏」后跟非数字 → searchHandler（不误入收藏）', async () => {
    await routeMessage(makeMsg({ content: '收藏夹怎么用' }));
    expect(searchHandler).toHaveBeenCalledTimes(1);
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

  it('非文本消息（event）静默忽略', async () => {
    await routeMessage(
      makeMsg({ msgType: 'event', content: '<xml/>' }),
    );
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('handler 可被后续注册覆盖（Task 9/12/13 插桩机制）', async () => {
    const replacement = vi.fn();
    registerHandlers({ search: replacement });
    await routeMessage(makeMsg({ content: 'go web 框架' }));
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
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

describe('默认 stub handlers（未注册时）', () => {
  it('不抛错、静默完成', async () => {
    resetHandlers();
    await expect(routeMessage(makeMsg({ content: '帮助' }))).resolves.toBeUndefined();
    await expect(routeMessage(makeMsg({ content: '收藏 3' }))).resolves.toBeUndefined();
    await expect(routeMessage(makeMsg({ content: '随便搜' }))).resolves.toBeUndefined();
  });
});
