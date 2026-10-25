import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, type LanguageModel } from 'ai';
import type { ZodSchema } from 'zod';
import { env } from '../config.js';

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
      // OpenCode Go 网关是 OpenAI 兼容 chat/completions：必须显式 .chat()，
      // 因为 @ai-sdk/openai 的默认入口是 /responses（多数第三方模型不支持）。
      return createOpenAI({
        apiKey,
        baseURL: baseURL?.trim() || OPENCODE_GO_BASE_URL,
        // 官方建议：用自己的 UA 标识客户端，并用稳定会话 ID 便于路由与缓存。
        headers: {
          'user-agent': 'github-trending-agent/1.0',
          'x-opencode-session': 'ghtrending-digest',
        },
      }).chat(modelId);
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
 * 对 prompt 做结构化对象生成；SDK 抛错、返回对象未过 zod 校验、
 * 网络失败等任何失败均返回 null，绝不 reject。
 * 成功后打印用量（provider/model/输入输出 token，不含内容），便于在
 * Vercel 日志核对成本。
 */
export async function generateObjectSafe<T>(
  schema: ZodSchema<T>,
  prompt: string,
): Promise<T | null> {
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
      `[llm] provider=${env.LLM_PROVIDER} model=${env.LLM_MODEL} ` +
        `input_tokens=${inputTokens ?? '?'} output_tokens=${outputTokens ?? '?'}`,
    );
    // SDK 已按 schema 校验；此处再 parse 一次以兜底（并保证返回类型为 T）。
    return schema.parse(result.object);
  } catch (err) {
    // 不打印内容，只打印原因：配置错（未知提供商、缺 baseURL）与鉴权/网络失败
    // 都不能静默——否则线上只会「一直没有中文简介」，无从排查。
    console.error(
      `[llm] provider=${env.LLM_PROVIDER} model=${env.LLM_MODEL} failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
