import { randomBytes } from 'node:crypto';
import { env } from '../config.js';

/** 邮箱确认/退订令牌（不透明随机串，避免可枚举）。 */
export function randomToken(): string {
  return randomBytes(24).toString('hex');
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string {
  const value = headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * 站点根地址：优先 PUBLIC_BASE_URL，其次请求 Host（Vercel 会给
 * x-forwarded-host）。
 *
 * cron 发信路径没有用户请求头，必须再回退到 Vercel 自动注入的 VERCEL_URL——
 * 否则邮件里的设置/退订链接与 List-Unsubscribe 头会写成 localhost，
 * 用户点不开、邮箱的一键退订也会失败（而请求型端点联调时完全看不出来）。
 */
export function resolveBaseUrl(
  headers?: Record<string, string | string[] | undefined>,
): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host =
    headerValue(headers, 'x-forwarded-host') || headerValue(headers, 'host');
  if (host) return `https://${host}`;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl.replace(/\/+$/, '')}`;
  return 'http://localhost:3000';
}
