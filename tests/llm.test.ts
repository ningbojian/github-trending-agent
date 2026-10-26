import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_TIMEOUT_MS, generateObjectSafe, llm, llmFor } from '../src/agent/llm';

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
  createOpenAICompatible: vi.fn(),
  createDeepSeek: vi.fn(),
  createAlibaba: vi.fn(),
  generateObject: vi.fn(),
  recordLlmFailure: vi.fn(async () => {}),
}));

vi.mock('../src/config', () => ({ env: mocks.env }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));
vi.mock('../src/agent/llm-failure', () => ({ recordLlmFailure: mocks.recordLlmFailure }));
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
  mocks.createOpenAICompatible.mockImplementation(() => ({
    chatModel: (modelId: string) => ({ provider: 'opencode-chat', modelId }),
  }));
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

  it('opencode: 用 OpenAI 兼容客户端，避免发出 OpenAI 专有的 structured outputs', () => {
    // 线上症状：所有简介都退化成英文截断，说明 generateObject 每次都失败。
    // 根因在请求体：@ai-sdk/openai 的 .chat() 会强制带
    // response_format={type:'json_schema',strict:true}（OpenAI Structured
    // Outputs）。OpenCode Go 网关背后的 DeepSeek 等模型只认
    // {type:'json_object'}，收到 json_schema 直接 400。
    // 官方为该网关标注的 AI SDK 包就是 @ai-sdk/openai-compatible。
    mocks.env.LLM_PROVIDER = 'opencode';

    expect(llm()).toEqual({ provider: 'opencode-chat', modelId: 'test-model' });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: 'opencode',
      apiKey: 'test-llm-api-key',
      baseURL: 'https://opencode.ai/inference/go/openai/v1',
      headers: { 'x-opencode-session': 'ghtrending-digest' },
    });
    // 绝不能走 @ai-sdk/openai（默认入口是 /responses，
    // 且会带上 json_schema structured outputs）。
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });

  it('opencode: honours LLM_BASE_URL (pay-as-you-go endpoint)', () => {
    mocks.env.LLM_PROVIDER = 'opencode';
    mocks.env.LLM_BASE_URL = 'https://opencode.ai/inference/openai/v1';

    llm();

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: 'opencode',
      apiKey: 'test-llm-api-key',
      baseURL: 'https://opencode.ai/inference/openai/v1',
      headers: { 'x-opencode-session': 'ghtrending-digest' },
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

describe('generateObjectSafe — 用户自备 Key（override）', () => {
  const schema = z.object({ ok: z.boolean() });
  const OVERRIDE = {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-user-own-key-123456',
  };

  it('走 createOpenAICompatible + chatModel（与 opencode 同一个理由：最朴素的 chat/completions）', async () => {
    mocks.generateObject.mockResolvedValue({ object: { ok: true } });

    await generateObjectSafe(schema, 'p', OVERRIDE);

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: 'user',
      baseURL: OVERRIDE.baseUrl,
      apiKey: OVERRIDE.apiKey,
    });
    expect(mocks.generateObject).toHaveBeenCalledWith({
      model: { provider: 'opencode-chat', modelId: OVERRIDE.model },
      schema,
      prompt: 'p',
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
    });
    // 用户自己的 Key 生效时，运营方 env 的 provider 完全不该参与
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
  });

  it('日志把 provider 记为 user，方便区分「烧的是谁的额度」', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.generateObject.mockResolvedValue({ object: { ok: true } });

    await generateObjectSafe(schema, 'p', OVERRIDE);

    expect(String(log.mock.calls[0][0])).toContain('provider=user');
    expect(String(log.mock.calls[0][0])).toContain(`model=${OVERRIDE.model}`);
    log.mockRestore();
  });

  it('失败原因里的 Key 一律脱敏（日志与 llm:last-error 都不得出现明文）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.generateObject.mockRejectedValue(
      new Error(`401 invalid key: ${OVERRIDE.apiKey} (header Authorization)`),
    );

    await expect(generateObjectSafe(schema, 'p', OVERRIDE)).resolves.toBeNull();

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(OVERRIDE.apiKey);
    expect(logged).toContain('sk-***');
    const recorded = JSON.stringify(mocks.recordLlmFailure.mock.calls);
    expect(recorded).not.toContain(OVERRIDE.apiKey);
    expect(recorded).toContain('provider');
    error.mockRestore();
  });

  it('运营方 env 坏掉时，override 仍然可用（不读 env 的模型配置）', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(mocks.env, 'LLM_PROVIDER');
    Object.defineProperty(mocks.env, 'LLM_PROVIDER', {
      configurable: true,
      get() {
        throw new Error('Invalid environment variables');
      },
    });
    mocks.generateObject.mockResolvedValue({ object: { ok: true } });

    try {
      await expect(generateObjectSafe(schema, 'p', OVERRIDE)).resolves.toEqual({
        ok: true,
      });
    } finally {
      if (descriptor) Object.defineProperty(mocks.env, 'LLM_PROVIDER', descriptor);
    }
  });
});

describe('llmFor', () => {
  it('用给定配置建模型，不碰任何 env', () => {
    mocks.env.LLM_PROVIDER = 'vertex'; // 未知提供商：只要读了 env 就会抛

    expect(
      llmFor({ baseUrl: 'https://x.example.com/v1', model: 'm', apiKey: 'k' }),
    ).toEqual({ provider: 'opencode-chat', modelId: 'm' });
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
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
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

  it('records the failure to the DB so it can be read without Vercel logs', async () => {
    // 失败只写 console.error 时，没有 Vercel 日志权限就完全无从排查：
    // 线上表现只是「简介一直是英文」，看不出是密钥、模型名还是请求体的问题。
    mocks.generateObject.mockRejectedValue(new Error('400 unsupported response_format'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await generateObjectSafe(schema, 'x');

    expect(mocks.recordLlmFailure).toHaveBeenCalledTimes(1);
    expect(mocks.recordLlmFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'test-model',
        message: expect.stringContaining('unsupported response_format'),
      }),
    );
  });

  it('does not record anything when generation succeeds', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { title: 'trending-repo', stars: 42 },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await generateObjectSafe(schema, 'x');

    expect(mocks.recordLlmFailure).not.toHaveBeenCalled();
  });

  it('returns null instead of rejecting when the provider itself cannot be created', async () => {
    mocks.env.LLM_PROVIDER = 'vertex';

    await expect(generateObjectSafe(schema, 'x')).resolves.toBeNull();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it('returns null instead of rejecting when reading env itself throws', async () => {
    // 生产上 env 是懒加载 Proxy：变量缺失/非法时，读取即抛出。
    // 老实现把 env.LLM_PROVIDER 直接写在 catch 里，于是这个错误会在
    // catch 里二次抛出，冒泡到调用方（fail-open 变成 fail-crash）。
    const descriptor = Object.getOwnPropertyDescriptor(mocks.env, 'LLM_PROVIDER');
    Object.defineProperty(mocks.env, 'LLM_PROVIDER', {
      configurable: true,
      get() {
        throw new Error('Invalid environment variables: LLM_API_KEY');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(generateObjectSafe(schema, 'x')).resolves.toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(mocks.env, 'LLM_PROVIDER', descriptor);
    }
  });
});

describe('generateObjectSafe — 重试与超时', () => {
  const schema = z.object({ ok: z.boolean() });

  it('一次失败就是一次失败：maxRetries 为 0，不串行重试三次', async () => {
    // SDK 默认 maxRetries = 2：provider 抽风时会串行重试三次才回退，
    // 而这条链路上本来就有一条「失败立即走正则」的免费退路。
    mocks.generateObject.mockResolvedValue({ object: { ok: true } });

    await generateObjectSafe(schema, 'p');

    expect(mocks.generateObject.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('超时会真的中止请求并立刻回退成 null，而不是挂到平台超时', async () => {
    // 真实 SDK 会监听 abortSignal；这里用 mock 复现同一行为，
    // 断言的是「超时信号确实被接上并触发了」。
    mocks.generateObject.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = Date.now();

    await expect(
      generateObjectSafe(schema, 'p', undefined, { timeoutMs: 20 }),
    ).resolves.toBeNull();

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('默认超时 30 秒（摘要批量要留足余量）', async () => {
    mocks.generateObject.mockResolvedValue({ object: { ok: true } });

    await generateObjectSafe(schema, 'p');

    const signal = mocks.generateObject.mock.calls[0][0]
      .abortSignal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});
