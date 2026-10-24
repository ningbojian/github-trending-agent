import { z } from 'zod';

/**
 * 可选环境变量：未设置或空字符串都视为缺省（.env 中复制模板常出现 `KEY=`）。
 */
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  // Neon Postgres（HTTP driver）
  NEON_DATABASE_URL: z.string().min(1),
  // LLM 提供商（anthropic | openai | deepseek | ali）
  LLM_PROVIDER: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  // 企业微信自建应用
  WECOM_CORP_ID: z.string().min(1),
  WECOM_AGENT_ID: z.string().min(1),
  WECOM_SECRET: z.string().min(1),
  WECOM_CALLBACK_TOKEN: z.string().min(1),
  WECOM_CALLBACK_AES_KEY: z.string().min(1),
  // 可选：管理员 userid，用于失败告警推送
  WECOM_ADMIN_USERID: optionalString,
  // 可选：出站中转（message/send 经固定 IP 中转，规避企微白名单）。仅 message/send 走中转，gettoken 仍直连。
  WECOM_RELAY_URL: optionalString,
  WECOM_RELAY_SECRET: optionalString,
  // GitHub OAuth App
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_OAUTH_REDIRECT_URI: z.string().min(1),
  // 可选：服务端 GitHub token，用于提高 API 限额
  GITHUB_TOKEN: optionalString,
  // 可选：仓库中文简介模式（默认 llm；off = 完全不调 LLM，全部走 description 截断，零 token）
  REPO_SUMMARY_MODE: optionalString,
  // 安全
  CRON_SECRET: z.string().min(1),
  TOKEN_ENCRYPT_KEY: z.string().min(1),
});

/**
 * Trending 抓取器覆盖的 per-language 榜单（URL slug，小写）。
 * 总榜（无语言过滤）单独抓取，语言哨兵值为 'all'。
 * URL 经 encodeURIComponent 编码（c++ → c%2B%2B、c# → c%23）；
 * 某语言榜 404 时沿用「告警并跳过」，不重试。
 */
export const SCRAPER_LANGUAGES = [
  'python',
  'typescript',
  'javascript',
  'go',
  'rust',
  'java',
  'c',
  'c++',
  'c#',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'shell',
  'html',
  'css',
  'vue',
  'lua',
] as const;

export type Env = z.infer<typeof envSchema>;

/**
 * 校验并解析环境变量；缺少必填变量（或值为空字符串）时抛出含字段名的错误。
 */
export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ');
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/**
 * 惰性单例：首次访问属性时才对 process.env 做校验并缓存，
 * 避免仅导入模块（如单元测试）即因缺 env 而抛错。
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    cached ??= loadEnv(process.env);
    return cached[prop as keyof Env];
  },
});
