import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, type LanguageModel } from 'ai';
import type { ZodSchema } from 'zod';
import { env } from '../config.js';
import { recordLlmFailure } from './llm-failure.js';

/** env.LLM_PROVIDER 的合法取值。 */
const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'deepseek',
  'ali',
  'mimo',
  'zhipu',
  'moonshot',
  'doubao',
  'siliconflow',
  'openrouter',
  'gemini',
  'ollama',
  'opencode',
  'custom',
] as const;

/** 小米 MiMo 开放平台：Anthropic 兼容协议 endpoint。 */
const MIMO_BASE_URL = 'https://api.xiaomimimo.com/anthropic';

/**
 * OpenCode Go 订阅的推理网关（OpenAI 兼容 chat/completions）。
 * 按量付费（Console 余额）用同一客户端，只把 LLM_BASE_URL 指到
 * https://opencode.ai/inference/openai/v1 即可。
 */
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';

/**
 * OpenAI 兼容协议的常见厂商 endpoint（`LLM_BASE_URL` 可覆盖任意一家）。
 * 未列入的值一律视为未知提供商；`custom` 必须显式给 `LLM_BASE_URL`。
 */
const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string | undefined> = {
  openai: undefined, // SDK 内置 https://api.openai.com/v1
  zhipu: 'https://open.bigmodel.cn/api/paas/v4', // 智谱 GLM
  moonshot: 'https://api.moonshot.cn/v1', // Kimi
  doubao: 'https://ark.cn-beijing.volces.com/api/v3', // 火山方舟
  siliconflow: 'https://api.siliconflow.cn/v1', // 硅基流动
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1', // 本地部署
  custom: undefined, // 由 LLM_BASE_URL 提供
};

/** baseURL 为空时不传该字段，保持各 SDK 的默认 endpoint。 */
function withBaseUrl(
  options: { apiKey: string },
  baseURL: string | undefined,
): { apiKey: string; baseURL?: string } {
  const trimmed = baseURL?.trim();
  return trimmed ? { ...options, baseURL: trimmed } : options;
}

/**
 * 按 env.LLM_PROVIDER 实例化对应提供商，返回 env.LLM_MODEL 的模型实例。
 * 未知提供商抛出含合法取值的错误；`custom` 缺 `LLM_BASE_URL` 时同样报错。
 */
export function llm(): LanguageModel {
  const raw = env.LLM_PROVIDER;
  const provider = raw.trim().toLowerCase();
  const apiKey = env.LLM_API_KEY;
  const modelId = env.LLM_MODEL;
  const baseURL = env.LLM_BASE_URL;

  switch (provider) {
    case 'anthropic':
      return createAnthropic(withBaseUrl({ apiKey }, baseURL))(modelId);
    case 'deepseek':
      // SDK 默认直连 api.deepseek.com；LLM_BASE_URL 用于区域端点/代理。
      return createDeepSeek(withBaseUrl({ apiKey }, baseURL))(modelId);
    case 'ali':
      // @ai-sdk/ali 在 npm 不存在；官方阿里云提供商包为 @ai-sdk/alibaba（导出 alibaba）。
      // SDK 默认走 dashscope-intl；大陆账号需用 LLM_BASE_URL 指到同区域端点。
      return createAlibaba(withBaseUrl({ apiKey }, baseURL))(modelId);
    case 'mimo':
      // 小米 MiMo 提供 Anthropic 兼容协议，复用 Anthropic 客户端并覆盖 baseURL。
      return createAnthropic({ apiKey, baseURL: baseURL ?? MIMO_BASE_URL })(modelId);
    case 'opencode':
      // 必须用 @ai-sdk/openai-compatible（也是官方为该网关标注的包），不能
      // 用 @ai-sdk/openai：后者的 chat 模型会把 generateObject 变成
      // response_format={type:'json_schema',strict:true}（OpenAI 专有的
      // Structured Outputs），而网关背后的 DeepSeek 等模型只认
      // {type:'json_object'}，收到 json_schema 直接 400 —— 表现为简介全部
      // 退化成英文截断。这里发出的才是最朴素的 chat/completions 请求。
      return createOpenAICompatible({
        name: 'opencode',
        apiKey,
        baseURL: baseURL?.trim() || OPENCODE_GO_BASE_URL,
        // OpenCode Go 要求带会话标识，否则 400 MissingSessionID。
        headers: { 'x-opencode-session': 'ghtrending-digest' },
      }).chatModel(modelId);
    default:
      break;
  }

  if (Object.prototype.hasOwnProperty.call(OPENAI_COMPATIBLE_BASE_URLS, provider)) {
    const endpoint = baseURL ?? OPENAI_COMPATIBLE_BASE_URLS[provider];
    if (provider === 'custom' && !endpoint?.trim()) {
      throw new Error(
        'LLM_PROVIDER="custom" requires LLM_BASE_URL (OpenAI-compatible endpoint, e.g. https://your-host/v1).',
      );
    }
    return createOpenAI(withBaseUrl({ apiKey }, endpoint))(modelId);
  }

  throw new Error(
    `Unknown LLM_PROVIDER "${raw}". Allowed providers: ${LLM_PROVIDERS.join(', ')}`,
  );
}

/**
 * 读取当前的 provider/model 标签用于日志与诊断记录。
 *
 * env 是懒加载 Proxy：变量缺失/非法时**读取即抛**。这个读取既不能在
 * try 之外（会直接崩），也不能写在 catch 里（错误会二次抛出，把
 * 「失败返回 null」变成「失败冒泡」）—— 所以单独兜一层。
 */
function llmLabel(): { provider: string; model: string } {
  try {
    return { provider: env.LLM_PROVIDER, model: env.LLM_MODEL };
  } catch {
    return { provider: '<env-invalid>', model: '<env-invalid>' };
  }
}

/**
 * 对 prompt 做结构化对象生成；SDK 抛错、返回对象未过 zod 校验、
 * 网络失败等任何失败均返回 null，绝不 reject。
 * 成功后打印用量（provider/model/输入输出 token，不含内容），便于在
 * Vercel 日志核对成本；失败时除日志外还写一条 6 小时的诊断记录到
 * kv_cache（`llm:last-error`），因为线上往往拿不到 Vercel 日志。
 */
export async function generateObjectSafe<T>(
  schema: ZodSchema<T>,
  prompt: string,
): Promise<T | null> {
  const { provider, model } = llmLabel();
  try {
    const result = await generateObject({ model: llm(), schema, prompt });
    const usage = result.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
        }
      | undefined;
    const inputTokens = usage?.inputTokens ?? usage?.promptTokens;
    const outputTokens = usage?.outputTokens ?? usage?.completionTokens;
    console.log(
      `[llm] provider=${provider} model=${model} ` +
        `input_tokens=${inputTokens ?? '?'} output_tokens=${outputTokens ?? '?'}`,
    );
    // SDK 已按 schema 校验；此处再 parse 一次以兜底（并保证返回类型为 T）。
    return schema.parse(result.object);
  } catch (err) {
    // 不打印内容，只打印原因：配置错（未知提供商、缺 baseURL）与鉴权/网络失败
    // 都不能静默——否则线上只会「一直没有中文简介」，无从排查。
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[llm] provider=${provider} model=${model} failed:`, message);
    await recordLlmFailure({ provider, model, message });
    return null;
  }
}
