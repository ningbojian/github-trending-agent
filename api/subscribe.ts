import { eq } from 'drizzle-orm';
import { BRAND } from '../src/brand.js';
import { db } from '../src/db/client.js';
import { emailSubscribers, kvCache } from '../src/db/schema.js';
import { emailConfigured, sendEmail } from '../src/email/send.js';
import { resolveBaseUrl, randomToken } from '../src/email/tokens.js';
import { readBodyFields } from '../src/http/body.js';
import { escapeHtml, renderPage, sendHtml, type HtmlResponse } from '../src/http/html.js';
import { shanghaiToday } from '../src/agent/time.js';

/**
 * 邮箱订阅入口（GET 表单 / POST 邮箱）。
 * - body 兼容 string / Buffer / 已解析对象（Vercel 按 content-type 预解析）。
 * - **不泄露订阅状态与凭证**：无论邮箱是否已订阅、是否已退订，响应文案完全一致，
 *   且页面里绝不出现 unsubToken（否则任何人只要提交别人的邮箱就能读改其设置/退订）。
 *   - 新邮箱 / 未确认 → 发确认信；
 *   - 已确认 → 把设置/退订链接发到该邮箱（管理信）；
 *   - 已退订 → 发一封带一次性 token 的「恢复订阅」信，本人点击才恢复。
 * - 同地址 10 分钟冷却、全局每日 50 封确认类邮件上限（kv_cache），失败退号。
 */

export interface SubscribeRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

const CONFIRM_COOLDOWN_MS = 10 * 60 * 1000;
const CONFIRM_DAILY_CAP = 50;

/** 宽松但实用的邮箱校验（RFC 完整语法不必要）。 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function confirmCapKey(date: string): string {
  return `email_confirm_sent:${date}`;
}

/** 取一个邮件名额（全局每日上限）；超限返回 false。 */
async function takeConfirmSlot(date: string): Promise<boolean> {
  const key = confirmCapKey(date);
  const rows = await db().select().from(kvCache).where(eq(kvCache.key, key));
  const row = rows[0];
  const current =
    row && new Date(row.expiresAt).getTime() > Date.now()
      ? Number((row.value as { count?: unknown }).count ?? 0)
      : 0;
  if (current >= CONFIRM_DAILY_CAP) return false;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const value = { count: current + 1 };
  await db()
    .insert(kvCache)
    .values({ key, value, expiresAt })
    .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
  return true;
}

/**
 * 退还一个邮件名额：发信失败时调用。
 * 不退号会让失败尝试永久占掉当天的 50 封额度，Resend 恢复后当天也发不出去。
 */
async function releaseConfirmSlot(date: string): Promise<void> {
  const key = confirmCapKey(date);
  try {
    const rows = await db().select().from(kvCache).where(eq(kvCache.key, key));
    const row = rows[0];
    const current =
      row && new Date(row.expiresAt).getTime() > Date.now()
        ? Number((row.value as { count?: unknown }).count ?? 0)
        : 0;
    if (current <= 0) return;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const value = { count: current - 1 };
    await db()
      .insert(kvCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: kvCache.key, set: { value, expiresAt } });
  } catch (err) {
    console.error('confirm slot release failed:', err);
  }
}

function formPage(email = ''): string {
  const body = `<div style="font-size:14px;line-height:1.7;color:#1f2328;margin-bottom:16px;">
    填写邮箱后，我们会先发一封确认邮件。确认后每天在固定时间收到中文 GitHub 热榜简报。
  </div>
  <form method="post" action="/api/subscribe">
    <label for="email" style="display:block;font-size:14px;margin-bottom:6px;">邮箱地址</label>
    <input id="email" name="email" type="email" required value="${escapeHtml(email)}"
      style="width:100%;box-sizing:border-box;padding:12px 14px;font-size:16px;border:1px solid #d0d7de;border-radius:8px;">
    <button type="submit" style="margin-top:16px;width:100%;padding:12px 20px;font-size:16px;border:0;border-radius:8px;background:${BRAND.colors.accent};color:#ffffff;font-weight:600;">订阅</button>
  </form>
  <div style="margin-top:16px;font-size:12px;color:#656d76;line-height:1.6;">
    我们只发送简报，不发其他邮件；每封邮件都带退订链接。
  </div>`;
  return renderPage({ title: '订阅 GitHub 热榜简报', body });
}

function messagePage(title: string, message: string, extra = ''): string {
  return renderPage({
    title,
    body: `<div style="font-size:14px;line-height:1.7;color:#1f2328;">${message}</div>${extra}`,
  });
}

const NEUTRAL_MESSAGE =
  '如果这个邮箱可以订阅，我们已经发送了一封邮件，请查收（可能被归到垃圾箱）。';

/**
 * 统一的中性回执：新邮箱、已订阅、已退订、冷却中，页面完全一致。
 * 任何差异化文案都会让这个公开端点变成「某邮箱是否订阅过」的查询接口。
 */
function neutralPage(): string {
  return messagePage('请查收邮件', NEUTRAL_MESSAGE);
}

interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** 确认 / 恢复订阅邮件（带一次性 token 链接）。 */
function confirmMail(to: string, confirmUrl: string, resume: boolean): OutgoingMail {
  const title = resume
    ? '确认恢复订阅 GitHub 热榜简报'
    : '确认订阅 GitHub 热榜简报';
  const lead = resume
    ? '你好，点击下面的按钮恢复接收 GitHub 热榜简报。'
    : '你好，点击下面的按钮确认订阅 GitHub 热榜简报。';
  const textLead = resume
    ? '你好，请点击下面的链接恢复接收 GitHub 热榜简报：'
    : '你好，请点击下面的链接确认订阅 GitHub 热榜简报：';
  return {
    to,
    subject: title,
    text: [
      textLead,
      confirmUrl,
      '',
      '链接 48 小时内有效。如果这不是你本人操作，忽略本邮件即可。',
    ].join('\n'),
    html: renderPage({
      title,
      body: `<div style="font-size:14px;line-height:1.7;color:#1f2328;">${lead}链接 48 小时内有效。</div>
      <div style="margin-top:18px;"><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${BRAND.colors.accent};color:#ffffff;font-size:15px;text-decoration:none;font-weight:600;">${resume ? '恢复订阅' : '确认订阅'}</a></div>
      <div style="margin-top:16px;font-size:12px;color:#656d76;line-height:1.6;">如果这不是你本人操作，忽略本邮件即可。</div>`,
    }),
  };
}

/**
 * 管理邮件：把设置/退订链接发给邮箱本人。
 * 链接含长期 token，所以只走邮件，绝不出现在 HTTP 响应里。
 */
function manageMail(
  to: string,
  settingsUrl: string,
  unsubscribeUrl: string,
): OutgoingMail {
  return {
    to,
    subject: '你的 GitHub 热榜简报订阅管理',
    text: [
      '你好，这是你的 GitHub 热榜简报订阅管理链接：',
      `调整推送时间 / 频率：${settingsUrl}`,
      `退订：${unsubscribeUrl}`,
      '',
      '如果这不是你本人操作，忽略本邮件即可。',
    ].join('\n'),
    html: renderPage({
      title: '订阅管理',
      body: `<div style="font-size:14px;line-height:1.7;color:#1f2328;">你好，这是你的 GitHub 热榜简报订阅管理链接。</div>
      <div style="margin-top:18px;font-size:14px;line-height:1.9;">
        <a href="${escapeHtml(settingsUrl)}" style="color:${BRAND.colors.link};">调整推送时间 / 频率</a><br>
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#656d76;">退订</a>
      </div>
      <div style="margin-top:16px;font-size:12px;color:#656d76;line-height:1.6;">如果这不是你本人操作，忽略本邮件即可。</div>`,
    }),
  };
}

export default async function handler(
  req: SubscribeRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    sendHtml(res, 200, formPage());
    return;
  }
  if (method !== 'POST') {
    sendHtml(res, 405, messagePage('请求方式不支持', '本端点支持 GET / POST。'));
    return;
  }

  if (!emailConfigured()) {
    sendHtml(
      res,
      503,
      messagePage('邮箱订阅即将开放', '邮箱通道尚未配置，请稍后再试。'),
    );
    return;
  }

  const fields = readBodyFields(req.body);
  const email = (fields.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    sendHtml(res, 400, messagePage('邮箱格式不正确', '请返回上一页填写有效的邮箱地址。'));
    return;
  }

  const baseUrl = resolveBaseUrl(req.headers);
  const existing = (
    await db().select().from(emailSubscribers).where(eq(emailSubscribers.email, email))
  )[0];

  if (
    existing?.confirmSentAt &&
    Date.now() - new Date(existing.confirmSentAt).getTime() < CONFIRM_COOLDOWN_MS
  ) {
    // 冷却中：不再发信，但回执与其它分支一致（不暴露该地址是否存在于库里）。
    sendHtml(res, 200, neutralPage());
    return;
  }

  const today = shanghaiToday();
  if (!(await takeConfirmSlot(today))) {
    sendHtml(
      res,
      429,
      messagePage('今日确认邮件已达上限', '请明天再试，或直接联系管理员。'),
    );
    return;
  }

  const now = new Date();
  let rowId: number | undefined;
  try {
    if (existing?.confirmed) {
      rowId = existing.id;
      if (existing.active) {
        // 已订阅：只把管理链接发到邮箱本人，响应里不出现任何 token。
        await db()
          .update(emailSubscribers)
          .set({ confirmSentAt: now })
          .where(eq(emailSubscribers.id, existing.id));
        await sendEmail(
          manageMail(
            existing.email,
            `${baseUrl}/api/email-settings?t=${encodeURIComponent(existing.unsubToken)}`,
            `${baseUrl}/api/email-unsubscribe?t=${encodeURIComponent(existing.unsubToken)}`,
          ),
        );
      } else {
        // 已退订：恢复订阅必须由邮箱本人点击确认，第三方提交不能把人重新拉回名单。
        const confirmToken = randomToken();
        await db()
          .update(emailSubscribers)
          .set({ confirmToken, confirmSentAt: now })
          .where(eq(emailSubscribers.id, existing.id));
        await sendEmail(
          confirmMail(
            existing.email,
            `${baseUrl}/api/email-confirm?t=${encodeURIComponent(confirmToken)}`,
            true,
          ),
        );
      }
    } else {
      const confirmToken = randomToken();
      const inserted = await db()
        .insert(emailSubscribers)
        .values({
          email,
          confirmToken,
          unsubToken: randomToken(),
          confirmSentAt: now,
        })
        .onConflictDoUpdate({
          target: emailSubscribers.email,
          set: { confirmToken, confirmSentAt: now, active: true },
        })
        .returning({ id: emailSubscribers.id });
      rowId = inserted[0]?.id;
      await sendEmail(
        confirmMail(
          email,
          `${baseUrl}/api/email-confirm?t=${encodeURIComponent(confirmToken)}`,
          false,
        ),
      );
    }
  } catch (err) {
    console.error('subscribe email send failed:', err);
    // 发送失败：回滚冷却与令牌（允许立刻重试），并退还当日名额。
    if (rowId !== undefined) {
      try {
        await db()
          .update(emailSubscribers)
          .set({ confirmToken: null, confirmSentAt: null })
          .where(eq(emailSubscribers.id, rowId));
      } catch (rollbackErr) {
        console.error('subscribe rollback failed:', rollbackErr);
      }
    }
    await releaseConfirmSlot(today);
    sendHtml(res, 502, messagePage('邮件发送失败', '请稍后重试。'));
    return;
  }

  sendHtml(res, 200, neutralPage());
}
