import { env } from '../config.js';

/**
 * 正式生产域名（不含尾斜杠）；取不到返回 null。
 *
 * 为什么不用 `resolveBaseUrl()` 的 `VERCEL_URL` 兜底：那是每次部署的
 * `*-hash.vercel.app`，微信里可能被拦或需要 Vercel 认证。这里优先
 * `PUBLIC_BASE_URL` → `VERCEL_PROJECT_PRODUCTION_URL`，最后才是
 * `VERCEL_URL`；本地/测试返回 null（调用方自己决定降级）。
 */
export function productionBaseUrl(): string | null {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) {
    return `https://${production
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')}`;
  }

  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment) {
    return `https://${deployment
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')}`;
  }

  return null;
}
