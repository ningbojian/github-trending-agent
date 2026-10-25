import { env } from '../config.js';

/**
 * 邮件发信层：只实现 Resend HTTP API（不引入 nodemailer，少一个依赖）。
 * - 未配置（缺 RESEND_API_KEY 或 EMAIL_FROM）→ emailConfigured()=false，
 *   入口显示「即将开放」、cron 跳过，企微链路不受影响。
 * - 网络异常 / HTTP 5xx / 429：250ms 退避后重试一次（与 message/send 同策略）。
 * - HTTP 4xx 业务错误：不重试（重试只会复现同样结果）。
 */

const RESEND_URL = 'https://api.resend.com/emails';
const RETRY_BACKOFF_MS = 250;

/** 邮箱通道是否已配置（Resend key + 发件人）。 */
export function emailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 发送一封邮件；未配置、业务错误或重试后仍失败均抛错。 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error('email not configured (RESEND_API_KEY / EMAIL_FROM)');
  }

  const payload = JSON.stringify({
    from,
    to: [msg.to],
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    ...(msg.headers ? { headers: msg.headers } : {}),
  });
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };

  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers,
        body: payload,
      });
    } catch (err) {
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      // 5xx / 429 视为瞬断可重试；其余 4xx（鉴权/参数错误）重试无意义。
      if (attempt === 0 && (res.status >= 500 || res.status === 429)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new Error(`resend HTTP ${res.status}`);
    }
    return;
  }
}
