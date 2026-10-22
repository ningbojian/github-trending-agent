import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, type LanguageModel } from 'ai';
import type { ZodSchema } from 'zod';
import { env } from '../config.js';

/** env.LLM_PROVIDER 的合法取值。 */
const LLM_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'ali', 'mimo'] as const;

/** 小米 MiMo 开放平台：Anthropic 兼容协议 endpoint。 */
const MIMO_BASE_URL = 'https://api.xiaomimimo.com/anthropic';

/**
 * 按 env.LLM_PROVIDER 实例化对应提供商，返回 env.LLM_MODEL 的模型实例。
 * 未知提供商抛出含合法取值的错误。
 */
export function llm(): LanguageModel {
  const provider = env.LLM_PROVIDER;
  const apiKey = env.LLM_API_KEY;
  const modelId = env.LLM_MODEL;

  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'deepseek':
      return createDeepSeek({ apiKey })(modelId);
    case 'ali':
      // @ai-sdk/ali 在 npm 不存在；官方阿里云提供商包为 @ai-sdk/alibaba（导出 alibaba）。
      return createAlibaba({ apiKey })(modelId);
    case 'mimo':
      // 小米 MiMo 提供 Anthropic 兼容协议，复用 Anthropic 客户端并覆盖 baseURL。
      return createAnthropic({ apiKey, baseURL: MIMO_BASE_URL })(modelId);
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}". Allowed providers: ${LLM_PROVIDERS.join(', ')}`,
      );
  }
}

/**
 * 对 prompt 做结构化对象生成；SDK 抛错、返回对象未过 zod 校验、
 * 网络失败等任何失败均返回 null，绝不 reject。
 */
export async function generateObjectSafe<T>(
  schema: ZodSchema<T>,
  prompt: string,
): Promise<T | null> {
  try {
    const result = await generateObject({ model: llm(), schema, prompt });
    // SDK 已按 schema 校验；此处再 parse 一次以兜底（并保证返回类型为 T）。
    return schema.parse(result.object);
  } catch {
    return null;
  }
}
