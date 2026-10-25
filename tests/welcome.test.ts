import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/wecom/router';

/**
 * Task 6：新用户礼包（欢迎 + 首日简报）。
 * 关键不变量：
 * - 顺序固定：欢迎语 → 简报（用户先知道「我是谁」，立刻拿到「价值」）；
 * - 简报发送成功才写 search_caches（「收藏 N」只能指向用户真收到的列表）；
 * - 发送成功即置 last_digest_at，当天定时推送不再重复；
 * - 任一步失败只记日志、绝不外抛（fail-open，聊天主链路不受影响）。
 */

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
}));

const digestMock = vi.hoisted(() => ({
  buildDigestWithEntries: vi.fn(),
  buildDigestFromSnapshot: vi.fn(),
  saveRecentResults: vi.fn(),
  markDigestSent: vi.fn(),
}));

const snapshotMock = vi.hoisted(() => ({
  getDailySnapshot: vi.fn(),
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

vi.mock('../src/agent/digest', () => ({
  buildDigestWithEntries: digestMock.buildDigestWithEntries,
  buildDigestFromSnapshot: digestMock.buildDigestFromSnapshot,
  saveRecentResults: digestMock.saveRecentResults,
  markDigestSent: digestMock.markDigestSent,
}));

vi.mock('../src/agent/digest-snapshot', () => ({
  getDailySnapshot: snapshotMock.getDailySnapshot,
}));

import { sendWelcomeFlow, WELCOME_MESSAGE } from '../src/wecom/welcome';

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'ww_corp',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'event',
    content: '',
    msgId: '',
    event: 'enter_agent',
    ...overrides,
  };
}

const ENTRIES = [{ fullName: 'a/one' }, { fullName: 'b/two' }];

const DIGEST_CONTENT = '📊 今日 GitHub 热榜简报（2026-10-25）';

/**
 * 欢迎语与首日简报走同一个发送函数（都是 text，markdown 在个人微信里不可见），
 * 所以「简报发出去了」只能按内容区分，不能按调用次数区分。
 */
function digestSend(): [string, string] | undefined {
  return (apiMock.sendWeComText.mock.calls as [string, string][]).find(
    ([, content]) => content !== WELCOME_MESSAGE,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  snapshotMock.getDailySnapshot.mockResolvedValue(null);
  digestMock.buildDigestWithEntries.mockResolvedValue({
    content: DIGEST_CONTENT,
    entries: ENTRIES,
  });
  digestMock.buildDigestFromSnapshot.mockResolvedValue({
    content: DIGEST_CONTENT,
    entries: ENTRIES,
  });
  digestMock.saveRecentResults.mockResolvedValue(undefined);
  digestMock.markDigestSent.mockResolvedValue(undefined);
});

describe('sendWelcomeFlow — 欢迎 + 首日简报', () => {
  it('先发欢迎语，再发简报；简报后写缓存并标记当日已发', async () => {
    await sendWelcomeFlow(makeMsg());

    // 两次发送都走 text 通道：先欢迎语，后简报，顺序与内容一并钉死。
    expect(apiMock.sendWeComText.mock.calls).toEqual([
      ['alice', WELCOME_MESSAGE],
      ['alice', DIGEST_CONTENT],
    ]);
    // 简报按默认偏好构建（条数默认 10、全语言）。
    expect(digestMock.buildDigestWithEntries).toHaveBeenCalledWith({
      preferences: {},
    });
    // 「收藏 N」引用简报条目，顺序与消息一致。
    expect(digestMock.saveRecentResults).toHaveBeenCalledWith('alice', ENTRIES);
    expect(digestMock.markDigestSent).toHaveBeenCalledWith('alice');

    const sendOrders = apiMock.sendWeComText.mock.invocationCallOrder;
    expect(sendOrders[0]!).toBeLessThan(sendOrders[1]!);
    // 只有消息真正发出后才记账。
    expect(sendOrders[1]!).toBeLessThan(
      digestMock.saveRecentResults.mock.invocationCallOrder[0]!,
    );
    expect(
      digestMock.saveRecentResults.mock.invocationCallOrder[0]!,
    ).toBeLessThan(digestMock.markDigestSent.mock.invocationCallOrder[0]!);
  });

  it('当日快照可用时走快照构建：礼包多一段概览，且不额外调模型', async () => {
    const snapshot = {
      date: '2026-10-25',
      dataDate: '2026-10-25',
      abstract: '今天的榜单集中在 AI 工具与开发效率上。',
      items: [],
    };
    snapshotMock.getDailySnapshot.mockResolvedValue(snapshot);

    await sendWelcomeFlow(makeMsg());

    expect(digestMock.buildDigestFromSnapshot).toHaveBeenCalledWith(
      { preferences: {} },
      snapshot,
    );
    expect(digestMock.buildDigestWithEntries).not.toHaveBeenCalled();
    expect(digestSend()).toEqual(['alice', DIGEST_CONTENT]);
  });

  it('欢迎语压缩到 3 行以内：身份 + 自动简报 + 一个示例 + 帮助入口', () => {
    const lines = WELCOME_MESSAGE.split('\n');
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(WELCOME_MESSAGE).toContain('每日简报');
    expect(WELCOME_MESSAGE).toContain('本周 python 的 ai 项目');
    expect(WELCOME_MESSAGE).toContain('帮助');
  });

  it('欢迎语发送失败 → 简报照常送达（fail-open）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiMock.sendWeComText
      .mockRejectedValueOnce(new Error('welcome down'))
      .mockResolvedValueOnce(undefined);

    await sendWelcomeFlow(makeMsg());

    expect(digestSend()).toEqual(['alice', DIGEST_CONTENT]);
    expect(digestMock.markDigestSent).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('简报构建失败 → 不发简报、不写缓存、不标记，且不外抛', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    digestMock.buildDigestWithEntries.mockRejectedValue(new Error('db down'));

    await expect(sendWelcomeFlow(makeMsg())).resolves.toBeUndefined();

    expect(apiMock.sendWeComText.mock.calls).toEqual([
      ['alice', WELCOME_MESSAGE],
    ]);
    expect(digestSend()).toBeUndefined();
    expect(digestMock.saveRecentResults).not.toHaveBeenCalled();
    expect(digestMock.markDigestSent).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('简报发送失败 → 不写缓存、不标记（明天/下一小时仍会重试），且不外抛', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMock.sendWeComText
      .mockResolvedValueOnce(undefined) // 欢迎语成功
      .mockRejectedValueOnce(new Error('send down')); // 简报失败

    await expect(sendWelcomeFlow(makeMsg())).resolves.toBeUndefined();

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(2);
    expect(digestMock.saveRecentResults).not.toHaveBeenCalled();
    expect(digestMock.markDigestSent).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('写缓存失败 → 仍标记当日已发（避免同一份简报当天重复推送）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    digestMock.saveRecentResults.mockRejectedValue(new Error('cache down'));

    await sendWelcomeFlow(makeMsg());

    expect(digestMock.markDigestSent).toHaveBeenCalledWith('alice');
    errorSpy.mockRestore();
  });

  it('空榜（entries 为空）→ 仍记缓存调用与当日已发，占位文案就是当日简报', async () => {
    digestMock.buildDigestWithEntries.mockResolvedValue({
      content: '今日暂无符合条件的热榜项目。',
      entries: [],
    });

    await sendWelcomeFlow(makeMsg());

    expect(digestSend()).toEqual(['alice', '今日暂无符合条件的热榜项目。']);
    expect(digestMock.saveRecentResults).toHaveBeenCalledWith('alice', []);
    expect(digestMock.markDigestSent).toHaveBeenCalledWith('alice');
  });

  it('标记失败 → 不外抛（欢迎流程已送达，不影响原消息）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    digestMock.markDigestSent.mockRejectedValue(new Error('update down'));

    await expect(sendWelcomeFlow(makeMsg())).resolves.toBeUndefined();

    expect(digestSend()).toEqual(['alice', DIGEST_CONTENT]);
    errorSpy.mockRestore();
  });
});
