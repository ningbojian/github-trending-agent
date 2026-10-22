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
    expect(() => llm()).toThrow(/anthropic, openai, deepseek, ali/);
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
