import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateObjectSafe, llm } from '../src/agent/llm';

/**
 * env 惰性单例策略（同 callback.test.ts）：用 vi.mock 固定 src/config，
 * 测试中直接改写 mocks.env 即可切换提供商，无需 resetModules。
 */
const mocks = vi.hoisted(() => ({
  env: {
    LLM_PROVIDER: 'anthropic',
    LLM_API_KEY: 'test-llm-api-key',
    LLM_MODEL: 'test-model',
    LLM_BASE_URL: undefined as string | undefined,
  },
  createAnthropic: vi.fn(),
  createOpenAI: vi.fn(),
  createDeepSeek: vi.fn(),
  createAlibaba: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock('../src/config', () => ({ env: mocks.env }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: mocks.createDeepSeek }));
vi.mock('@ai-sdk/alibaba', () => ({ createAlibaba: mocks.createAlibaba }));
vi.mock('ai', () => ({ generateObject: mocks.generateObject }));

/** 每个 createXxx 工厂返回可辨识的假 provider，便于断言分支与 modelId。 */
const fakeProvider =
  (name: string) =>
  (modelId: string): { provider: string; modelId: string } => ({
    provider: name,
    modelId,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.LLM_PROVIDER = 'anthropic';
  mocks.env.LLM_API_KEY = 'test-llm-api-key';
  mocks.env.LLM_MODEL = 'test-model';
  mocks.env.LLM_BASE_URL = undefined;
  mocks.createAnthropic.mockImplementation(() => fakeProvider('anthropic'));
  mocks.createOpenAI.mockImplementation(() => fakeProvider('openai'));
  mocks.createDeepSeek.mockImplementation(() => fakeProvider('deepseek'));
  mocks.createAlibaba.mockImplementation(() => fakeProvider('ali'));
  mocks.generateObject.mockReset();
});

describe('llm provider branching', () => {
  it('anthropic: instantiates createAnthropic with the configured api key and model', () => {
    mocks.env.LLM_PROVIDER = 'anthropic';

    expect(llm()).toEqual({ provider: 'anthropic', modelId: 'test-model' });
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
    });
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createDeepSeek).not.toHaveBeenCalled();
    expect(mocks.createAlibaba).not.toHaveBeenCalled();
  });

  it('openai: instantiates createOpenAI with the configured api key and model', () => {
    mocks.env.LLM_PROVIDER = 'openai';

    expect(llm()).toEqual({ provider: 'openai', modelId: 'test-model' });
    expect(mocks.createOpenAI).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
    });
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createDeepSeek).not.toHaveBeenCalled();
    expect(mocks.createAlibaba).not.toHaveBeenCalled();
  });

  it('deepseek: instantiates createDeepSeek with the configured api key and model', () => {
    mocks.env.LLM_PROVIDER = 'deepseek';

    expect(llm()).toEqual({ provider: 'deepseek', modelId: 'test-model' });
    expect(mocks.createDeepSeek).toHaveBeenCalledTimes(1);
    expect(mocks.createDeepSeek).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
    });
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createAlibaba).not.toHaveBeenCalled();
  });

  it('ali: instantiates createAlibaba from @ai-sdk/alibaba with the configured api key and model', () => {
    mocks.env.LLM_PROVIDER = 'ali';

    expect(llm()).toEqual({ provider: 'ali', modelId: 'test-model' });
    expect(mocks.createAlibaba).toHaveBeenCalledTimes(1);
    expect(mocks.createAlibaba).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
    });
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createDeepSeek).not.toHaveBeenCalled();
  });

  it('deepseek / ali: honour LLM_BASE_URL for regional endpoints and proxies', () => {
    // 大陆账号/企业代理常需把 endpoint 指到同区域地址；忽略这个变量会让
    // 请求打到 SDK 默认（deepseek 直连 / dashscope-intl）而静默失败。
    mocks.env.LLM_PROVIDER = 'deepseek';
    mocks.env.LLM_BASE_URL = 'https://proxy.example.com/deepseek';
    llm();
    expect(mocks.createDeepSeek).toHaveBeenLastCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://proxy.example.com/deepseek',
    });

    mocks.env.LLM_PROVIDER = 'ali';
    mocks.env.LLM_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    llm();
    expect(mocks.createAlibaba).toHaveBeenLastCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  });

  it('mimo: reuses the Anthropic client with the MiMo baseURL override', () => {
    mocks.env.LLM_PROVIDER = 'mimo';
    mocks.createAnthropic.mockImplementation(() => fakeProvider('mimo'));

    expect(llm()).toEqual({ provider: 'mimo', modelId: 'test-model' });
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://api.xiaomimimo.com/anthropic',
    });
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createDeepSeek).not.toHaveBeenCalled();
    expect(mocks.createAlibaba).not.toHaveBeenCalled();
  });

  it('opencode: uses the Go chat-completions endpoint instead of /responses', () => {
    // OpenCode Go 的网关只提供 OpenAI 兼容的 chat/completions（models.dev:
    // opencode-go → @ai-sdk/openai-compatible）。@ai-sdk/openai 的默认入口是
    // /responses，必须显式 .chat()，否则 DeepSeek 这类模型直接 404。
    mocks.env.LLM_PROVIDER = 'opencode';
    const chat = vi.fn((modelId: string) => ({
      provider: 'opencode-chat',
      modelId,
    }));
    const client = Object.assign(vi.fn(), { chat, responses: vi.fn() });
    mocks.createOpenAI.mockImplementation(() => client as never);

    expect(llm()).toEqual({ provider: 'opencode-chat', modelId: 'test-model' });
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://opencode.ai/inference/go/openai/v1',
      headers: {
        'user-agent': 'github-trending-agent/1.0',
        'x-opencode-session': 'ghtrending-digest',
      },
    });
    expect(chat).toHaveBeenCalledWith('test-model');
    // 绝不能走默认调用入口（那会打到 /responses）
    expect(client).not.toHaveBeenCalled();
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });

  it('opencode: honours LLM_BASE_URL (pay-as-you-go endpoint)', () => {
    mocks.env.LLM_PROVIDER = 'opencode';
    mocks.env.LLM_BASE_URL = 'https://opencode.ai/inference/openai/v1';
    const chat = vi.fn((modelId: string) => ({ provider: 'opencode-chat', modelId }));
    mocks.createOpenAI.mockImplementation(
      () => Object.assign(vi.fn(), { chat }) as never,
    );

    llm();

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://opencode.ai/inference/openai/v1',
      headers: {
        'user-agent': 'github-trending-agent/1.0',
        'x-opencode-session': 'ghtrending-digest',
      },
    });
  });

  it('zhipu / gemini / moonshot: use the built-in OpenAI-compatible endpoint', () => {
    mocks.env.LLM_PROVIDER = 'zhipu';
    expect(llm()).toEqual({ provider: 'openai', modelId: 'test-model' });
    expect(mocks.createOpenAI).toHaveBeenLastCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    });

    mocks.env.LLM_PROVIDER = 'gemini';
    llm();
    expect(mocks.createOpenAI).toHaveBeenLastCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });

    mocks.env.LLM_PROVIDER = 'moonshot';
    llm();
    expect(mocks.createOpenAI).toHaveBeenLastCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://api.moonshot.cn/v1',
    });
  });

  it('custom: uses LLM_BASE_URL as the OpenAI-compatible endpoint', () => {
    mocks.env.LLM_PROVIDER = 'custom';
    mocks.env.LLM_BASE_URL = 'https://llm.internal.example.com/v1';

    expect(llm()).toEqual({ provider: 'openai', modelId: 'test-model' });
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://llm.internal.example.com/v1',
    });
  });

  it('custom: throws a clear error when LLM_BASE_URL is missing', () => {
    mocks.env.LLM_PROVIDER = 'custom';
    mocks.env.LLM_BASE_URL = undefined;

    expect(() => llm()).toThrow(/LLM_BASE_URL/);
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
  });

  it('LLM_BASE_URL overrides a preset endpoint (proxy / Azure / self-hosted)', () => {
    mocks.env.LLM_PROVIDER = 'zhipu';
    mocks.env.LLM_BASE_URL = 'https://proxy.example.com/v1';

    llm();
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://proxy.example.com/v1',
    });
  });

  it('trims and lowercases the provider slug', () => {
    mocks.env.LLM_PROVIDER = '  Zhipu ';

    expect(llm()).toEqual({ provider: 'openai', modelId: 'test-model' });
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-llm-api-key',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    });
  });

  it('reads env at call time so a changed LLM_PROVIDER switches the branch', () => {
    expect(llm()).toEqual({ provider: 'anthropic', modelId: 'test-model' });
    mocks.env.LLM_PROVIDER = 'deepseek';
    expect(llm()).toEqual({ provider: 'deepseek', modelId: 'test-model' });
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
    expect(mocks.createDeepSeek).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error naming the allowed values for an unknown provider', () => {
    mocks.env.LLM_PROVIDER = 'vertex';

    expect(() => llm()).toThrow(/vertex/);
    expect(() => llm()).toThrow(/anthropic, openai, deepseek, ali, mimo/);
    expect(() => llm()).toThrow(/opencode/);
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createDeepSeek).not.toHaveBeenCalled();
    expect(mocks.createAlibaba).not.toHaveBeenCalled();
  });
});

describe('generateObjectSafe', () => {
  const schema = z.object({ title: z.string(), stars: z.number() });

  it('passes the llm model, schema and prompt through and returns the object', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { title: 'trending-repo', stars: 42 },
    });

    const result = await generateObjectSafe(schema, 'summarize this repo');

    expect(result).toEqual({ title: 'trending-repo', stars: 42 });
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(mocks.generateObject).toHaveBeenCalledWith({
      model: { provider: 'anthropic', modelId: 'test-model' },
      schema,
      prompt: 'summarize this repo',
    });
  });

  it('returns null instead of rejecting when generateObject throws (SDK/network failure)', async () => {
    mocks.generateObject.mockRejectedValue(new Error('network down'));

    await expect(generateObjectSafe(schema, 'x')).resolves.toBeNull();
  });

  it('logs the failure reason so a broken provider is visible in the logs', async () => {
    // 静默 null 会让「未知提供商 / 缺 baseURL / 鉴权失败」永远查不出来，
    // 表现为线上一直没有中文简介。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.generateObject.mockRejectedValue(new Error('invalid api key'));

    await generateObjectSafe(schema, 'x');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('provider=anthropic');
    expect(String(spy.mock.calls[0][1])).toContain('invalid api key');
    spy.mockRestore();
  });

  it('returns null when the returned object fails zod validation', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { title: 123, stars: 'many' },
    });

    await expect(generateObjectSafe(schema, 'x')).resolves.toBeNull();
  });

  it('returns null instead of rejecting when the provider itself cannot be created', async () => {
    mocks.env.LLM_PROVIDER = 'vertex';

    await expect(generateObjectSafe(schema, 'x')).resolves.toBeNull();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});
