import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/wecom/router';

/**
 * 「设置模型 / 我的模型 / 清除模型」三个会话命令。
 * 全部副作用 mock：不连库、不碰真实 env、不发消息。
 */

const ENV = vi.hoisted(() => ({
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key' as string | undefined,
  PUBLIC_BASE_URL: 'https://agent.example.com' as string | undefined,
}));

vi.mock('../src/config', () => ({ env: ENV }));

const apiMock = vi.hoisted(() => ({ sendWeComText: vi.fn() }));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

const userLlmMock = vi.hoisted(() => ({
  loadUserLlm: vi.fn(),
  clearUserLlm: vi.fn(),
}));

vi.mock('../src/agent/user-llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/user-llm')>();
  return {
    ...actual,
    loadUserLlm: userLlmMock.loadUserLlm,
    clearUserLlm: userLlmMock.clearUserLlm,
  };
});

// 本文件不碰 db：给了空壳也不会被调用（user-llm 的读写全部被上面的 mock 顶替）。
vi.mock('../src/db/client', () => ({ db: () => ({}) }));

import {
  CLEAR_MODEL_FAILURE_REPLY,
  CLEAR_MODEL_REPLY,
  SET_MODEL_FAILURE_REPLY,
  buildSetKeyLink,
  handleClearModel,
  handleMyModel,
  handleSetModel,
} from '../src/wecom/llm-settings';

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'gh_agent',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'text',
    content: '设置模型',
    msgId: '1001',
    ...overrides,
  };
}

/** 取第 n 条发出消息的正文。 */
function sentText(index = 0): string {
  return String(apiMock.sendWeComText.mock.calls[index]?.[1] ?? '');
}

const USER_LLM = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-unit-test-abcdefgh1234',
};

beforeEach(() => {
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  userLlmMock.loadUserLlm.mockReset();
  userLlmMock.loadUserLlm.mockResolvedValue(null);
  userLlmMock.clearUserLlm.mockReset();
  userLlmMock.clearUserLlm.mockResolvedValue(undefined);
  ENV.TOKEN_ENCRYPT_KEY = 'unit-test-encrypt-key';
  ENV.PUBLIC_BASE_URL = 'https://agent.example.com';
});

// ---------------------------------------------------------------------------
// buildSetKeyLink：一次性链接的拼装（含「缺加密密钥」的显式拒绝）
// ---------------------------------------------------------------------------
describe('buildSetKeyLink', () => {
  it('返回 PUBLIC_BASE_URL 下的 /api/set-key 链接，token 经 url 编码', () => {
    const link = buildSetKeyLink('alice');
    expect(link.startsWith('https://agent.example.com/api/set-key?t=')).toBe(true);
    const token = decodeURIComponent(link.split('?t=')[1] ?? '');
    expect(token).toContain('.');
    expect(token).not.toContain('/');
  });

  it('TOKEN_ENCRYPT_KEY 缺失 → 抛错（调用方回「服务未配置加密密钥」）', () => {
    ENV.TOKEN_ENCRYPT_KEY = undefined;
    expect(() => buildSetKeyLink('alice')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleSetModel：「设置模型」回一次性链接
// ---------------------------------------------------------------------------
describe('handleSetModel', () => {
  it('发一条含链接的消息，并说明 15 分钟 / 只能用一次', async () => {
    await handleSetModel(makeMsg());

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText.mock.calls[0]?.[0]).toBe('alice');
    const text = sentText();
    expect(text).toContain('https://agent.example.com/api/set-key?t=');
    expect(text).toContain('15 分钟');
    expect(text).toContain('一次');
  });

  it('未配置加密密钥 → 回固定失败文案，绝不发畸形链接', async () => {
    ENV.TOKEN_ENCRYPT_KEY = undefined;

    await handleSetModel(makeMsg());

    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      SET_MODEL_FAILURE_REPLY,
    );
    expect(SET_MODEL_FAILURE_REPLY).toContain('加密密钥');
  });

  it('发送失败 → 吞掉异常（不向上抛，避免 router 二次兜底）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));

    await expect(handleSetModel(makeMsg())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// handleMyModel：「我的模型」回当前配置（Key 只露掩码）
// ---------------------------------------------------------------------------
describe('handleMyModel', () => {
  it('已配置 → 回接口 / 模型 / 掩码 Key，绝不回显明文 Key', async () => {
    userLlmMock.loadUserLlm.mockResolvedValue(USER_LLM);

    await handleMyModel(makeMsg({ content: '我的模型' }));

    const text = sentText();
    expect(text).toContain('https://api.deepseek.com/v1');
    expect(text).toContain('deepseek-chat');
    expect(text).toContain('sk-…1234');
    expect(text).not.toContain(USER_LLM.apiKey);
  });

  it('未配置 → 说明互动走规则模式（零额度）并给出设置入口', async () => {
    await handleMyModel(makeMsg({ content: '我的模型' }));

    const text = sentText();
    expect(text).toContain('未配置');
    expect(text).toContain('设置模型');
  });
});

// ---------------------------------------------------------------------------
// handleClearModel：「清除模型」删三列
// ---------------------------------------------------------------------------
describe('handleClearModel', () => {
  it('清除成功 → 调 clearUserLlm 并回确认文案', async () => {
    await handleClearModel(makeMsg({ content: '清除模型' }));

    expect(userLlmMock.clearUserLlm).toHaveBeenCalledWith('alice');
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', CLEAR_MODEL_REPLY);
  });

  it('清除失败 → 回兜底文案，不向上抛', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    userLlmMock.clearUserLlm.mockRejectedValue(new Error('db down'));

    await expect(handleClearModel(makeMsg())).resolves.toBeUndefined();
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      CLEAR_MODEL_FAILURE_REPLY,
    );
    errorSpy.mockRestore();
  });
});
