import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../crypto/secret.js';
import { db } from '../db/client.js';
import { subscribers } from '../db/schema.js';
import { redactKey, extraLlmHeaders } from './llm.js';

/**
 * 用户自备的 LLM 配置（subscribers.llm_base_url / llm_model / llm_key_enc）。
 *
 * 归属划分：每日推送（快照 + 中文简介 + Abstract）用运营方 env.LLM_*，
 * 每天一次，属于基础功能；**互动**（解析搜索意图、给搜索结果写中文简介）
 * 用这里的三列。没配 = 零调用，退回规则解析 + 共享缓存。
 *
 * 安全：Key 只在 HTTPS 请求体里出现一次，落库前 AES-256-GCM 加密；
 * 读取失败（换过密钥/被篡改）按未配置处理，日志绝不打印明文。
 */

export interface UserLlmConfig {
  /** OpenAI 兼容 endpoint（必须 https://）。 */
  baseUrl: string;
  /** 模型名（原样透传给厂商）。 */
  model: string;
  /** API Key（只在内存与密文里存在）。 */
  apiKey: string;
}

export interface LlmPreset {
  key: string;
  label: string;
  baseUrl: string;
  model: string;
}

/** 表单下拉的一键回填项（用户仍可手改任意字段）。 */
export const PRESETS: LlmPreset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    key: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
  },
  {
    key: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
];

/** 掩码：只露前 3 位与后 4 位；太短的 Key 整体打码（否则等于泄露大半）。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export type LlmInputResult =
  | { ok: true; config: UserLlmConfig }
  | { ok: false; error: string };

/**
 * 已知「官网 ≠ API」的域名映射。
 *
 * 用户最常见的错误是把控制台/产品页当 Base URL 填进来：请求打到网页上，
 * 得到 404 加一整段 HTML，试连失败还看不出原因。这里把明显的官网地址
 * 直接映射到同一家的 API 地址；路径已经在 API 前缀下的不重复改。
 */
const WEBSITE_TO_API: Array<{
  hosts: string[];
  /** 路径以此开头时认为已经是 API 地址，不再映射。 */
  apiPathPrefix?: string;
  api: string;
}> = [
  {
    hosts: ['deepseek.com', 'www.deepseek.com', 'platform.deepseek.com', 'chat.deepseek.com'],
    apiPathPrefix: '/v1',
    api: 'https://api.deepseek.com/v1',
  },
  {
    hosts: ['opencode.ai', 'www.opencode.ai'],
    apiPathPrefix: '/inference/',
    api: 'https://opencode.ai/inference/go/openai/v1',
  },
];

/**
 * 规范化用户填的 Base URL：
 * - 去空白、去掉尾斜杠；
 * - 已经是 API 地址的保持不变；
 * - 明显的官网地址映射到对应 API 地址；
 * - 误把完整 `/chat/completions` 粘进来的，去掉该后缀。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = url.hostname.toLowerCase();
  for (const rule of WEBSITE_TO_API) {
    if (!rule.hosts.includes(host)) continue;
    if (rule.apiPathPrefix && url.pathname.startsWith(rule.apiPathPrefix)) {
      return trimmed;
    }
    return rule.api;
  }
  return trimmed.replace(/\/chat\/completions$/, '');
}

/**
 * 校验网页表单输入：去空白、归一化 Base URL。
 * 只接受 https:// —— Key 会随请求发往该地址，明文走 http 等于公开。
 */
export function validateUserLlmInput(input: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): LlmInputResult {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? '');
  const model = (input.model ?? '').trim();
  const apiKey = (input.apiKey ?? '').trim();
  if (!baseUrl) {
    return { ok: false, error: '请填写接口地址（Base URL），例如 https://api.deepseek.com/v1' };
  }
  if (!baseUrl.startsWith('https://')) {
    return { ok: false, error: '接口地址需以 https:// 开头' };
  }
  if (!model) {
    return { ok: false, error: '请填写模型名，例如 deepseek-chat' };
  }
  if (!apiKey) {
    return { ok: false, error: '请填写 API Key' };
  }
  return { ok: true, config: { baseUrl, model, apiKey } };
}

/**
 * 读取并解密用户的 LLM 配置；三列任一缺失、解密失败、DB 异常都返回 null
 * （fail-open：互动退回规则模式，绝不阻塞消息）。
 */
/** 试连失败原因里最多保留的字符数（表单会原样显示）。 */
const PING_REASON_MAX_CHARS = 120;
/** 试连超时：用户填错地址时别让表单转圈太久。 */
const PING_TIMEOUT_MS = 10_000;

export type PingResult = { ok: true } | { ok: false; error: string };

/** 把厂商响应/异常压成一行短原因，并抹掉疑似 Key。 */
function shortReason(text: string): string {
  const clean = redactKey(text).replace(/\s+/g, ' ').trim();
  return clean.length > PING_REASON_MAX_CHARS
    ? `${clean.slice(0, PING_REASON_MAX_CHARS)}…`
    : clean;
}

/**
 * 用用户自己的 Key 发一次最小请求（max_tokens=1），确认地址/模型/Key 三者都对。
 * 保存前调用：连不通就不落库，用户当场看到原因，而不是回到微信后「互动没反应」。
 * 任何失败都返回 `{ ok: false }`，绝不抛错 —— 调用方只做分支判断。
 */
export async function pingLlm(
  config: UserLlmConfig,
  timeoutMs: number = PING_TIMEOUT_MS,
): Promise<PingResult> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        // OpenCode Go 之类要求会话头，否则 400 MissingSessionID。
        ...extraLlmHeaders(config.baseUrl),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // 返回 HTML 基本只有一种可能：填成了官网/控制台地址，而不是 API。
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        return {
          ok: false,
          error:
            `接口返回 ${res.status}：这个地址返回的是网页，不是 API。` +
            '请确认 Base URL：DeepSeek 用 https://api.deepseek.com/v1；OpenCode Go 用 https://opencode.ai/inference/go/openai/v1',
        };
      }
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        error: detail
          ? `接口返回 ${res.status}：${shortReason(detail)}`
          : `接口返回 ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `连接失败：${shortReason(message)}` };
  }
}

export async function loadUserLlm(
  wecomUserid: string,
): Promise<UserLlmConfig | null> {
  try {
    const row = (
      await db()
        .select()
        .from(subscribers)
        .where(eq(subscribers.wecomUserid, wecomUserid))
        .limit(1)
    )[0];
    if (!row?.llmBaseUrl || !row.llmModel || !row.llmKeyEnc) {
      return null;
    }
    return {
      baseUrl: row.llmBaseUrl,
      model: row.llmModel,
      apiKey: decryptSecret(row.llmKeyEnc),
    };
  } catch (err) {
    // 只记原因，不记密文也不记明文。
    console.warn(
      'loadUserLlm failed (fall back to rule mode):',
      err instanceof Error ? err.message : 'unknown error',
    );
    return null;
  }
}

/** 保存（覆盖）用户 LLM 配置；Key 在这里一次性加密。 */
export async function saveUserLlm(
  wecomUserid: string,
  config: UserLlmConfig,
): Promise<void> {
  await db()
    .update(subscribers)
    .set({
      llmBaseUrl: config.baseUrl,
      llmModel: config.model,
      llmKeyEnc: encryptSecret(config.apiKey),
    })
    .where(eq(subscribers.wecomUserid, wecomUserid));
}

/** 清除用户 LLM 配置（三列一起置空）。 */
export async function clearUserLlm(wecomUserid: string): Promise<void> {
  await db()
    .update(subscribers)
    .set({ llmBaseUrl: null, llmModel: null, llmKeyEnc: null })
    .where(eq(subscribers.wecomUserid, wecomUserid));
}

/** 「我的模型」回复文案；未配置时明说互动会退回零消耗模式。 */
export function describeUserLlm(config: UserLlmConfig | null): string {
  if (!config) {
    return [
      '未配置。互动将使用规则解析 + 共享缓存简介（不消耗任何模型额度）。',
      '想用你自己的 AI Key 做互动，发「设置模型」。',
    ].join('\n');
  }
  return [
    '已配置（互动使用你自己的 Key）：',
    `· 接口：${config.baseUrl}`,
    `· 模型：${config.model}`,
    `· Key：${maskKey(config.apiKey)}`,
    '发「清除模型」可删除。',
  ].join('\n');
}
