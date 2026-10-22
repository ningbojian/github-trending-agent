import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerHandlers,
  resetHandlers,
  routeMessage,
  type InboundMessage,
} from '../src/wecom/router';

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

  it('handler 抛错时 routeMessage 以 rejected promise 暴露（调用方负责 catch）', async () => {
    searchHandler.mockRejectedValueOnce(new Error('boom'));
    await expect(routeMessage(makeMsg({ content: 'anything' }))).rejects.toThrow(
      'boom',
    );
  });

  it('handler 可被后续注册覆盖（Task 9/12/13 插桩机制）', async () => {
    const replacement = vi.fn();
    registerHandlers({ search: replacement });
    await routeMessage(makeMsg({ content: 'go web 框架' }));
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
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
