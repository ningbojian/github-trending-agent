import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { emailSubscribers } from '../src/db/schema.js';
import { getDailySnapshot, selectEntriesForPreferences } from '../src/agent/digest-snapshot.js';
import { normalizeEmailPreferences } from '../src/email/preferences.js';
import { renderDigestEmail } from '../src/email/render.js';
import { sendEmail } from '../src/email/send.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { escapeHtml, renderPage, sendHtml, type HtmlResponse } from '../src/http/html.js';

/**
 * 邮箱确认端点（GET /api/email-confirm?t=…）。
 * - confirmToken 48 小时内有效（以 confirmSentAt 计）；未知/过期 → 错误页、零写入。
 * - 确认成功 → confirmed=true、active=true、confirmToken=null → 立即发今日简报；
 *   发送成功才把 lastSentAt 记为北京当日 00:00（当天的整点 tick 不再重复发）。
 * - 快照不可用/发送失败：确认仍然生效，简报留给下一个整点 tick。
 */

export interface ConfirmRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
}

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

function firstParam(
  query: ConfirmRequest['query'],
  name: string,
): string | undefined {
  const value = query?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single == null || single === '' ? undefined : single;
}

function messagePage(title: string, message: string, extra = ''): string {
  return renderPage({
    title,
    body: `<div style="font-size:14px;line-height:1.7;color:#1f2328;">${message}</div>${extra}`,
  });
}

export default async function handler(
  req: ConfirmRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    sendHtml(res, 405, messagePage('请求方式不支持', '本端点仅支持 GET。'));
    return;
  }

  const token = firstParam(req.query, 't');
  if (!token) {
    sendHtml(res, 400, messagePage('链接无效', '缺少确认参数，请重新订阅。'));
    return;
  }

  const row = (
    await db()
      .select()
      .from(emailSubscribers)
      .where(eq(emailSubscribers.confirmToken, token))
  )[0];
  if (!row) {
    sendHtml(res, 404, messagePage('链接无效或已使用', '请重新订阅。'));
    return;
  }
  if (
    !row.confirmSentAt ||
    Date.now() - new Date(row.confirmSentAt).getTime() > TOKEN_TTL_MS
  ) {
    sendHtml(
      res,
      400,
      messagePage('确认链接已过期', '请返回订阅页重新提交邮箱。'),
    );
    return;
  }

  // 以 confirmToken 为条件抢占：同一链接的并发点击（双击、邮件网关预取 + 用户点击）
  // 只有一个请求能拿到返回行，其余按「已使用」处理，绝不重复发今天这封简报。
  const claimed = await db()
    .update(emailSubscribers)
    .set({
      confirmed: true,
      active: true,
      confirmToken: null,
      confirmedAt: new Date(),
    })
    .where(
      and(
        eq(emailSubscribers.id, row.id),
        eq(emailSubscribers.confirmToken, token),
      ),
    )
    .returning({ id: emailSubscribers.id });
  if (claimed.length === 0) {
    sendHtml(res, 404, messagePage('链接无效或已使用', '请重新订阅。'));
    return;
  }

  const baseUrl = resolveBaseUrl(req.headers);
  const preferences = normalizeEmailPreferences(row.preferences);
  const settings = `${baseUrl}/api/email-settings?t=${encodeURIComponent(row.unsubToken)}`;
  const unsubscribe = `${baseUrl}/api/email-unsubscribe?t=${encodeURIComponent(row.unsubToken)}`;
  const links = `<div style="margin-top:18px;font-size:14px;line-height:1.8;">
    <a href="${escapeHtml(settings)}" style="color:#0969da;">调整推送时间 / 频率</a><br>
    <a href="${escapeHtml(unsubscribe)}" style="color:#656d76;">退订</a>
  </div>`;

  let digestSent = false;
  try {
    const snapshot = await getDailySnapshot();
    if (snapshot) {
      const items = selectEntriesForPreferences(
        snapshot.items,
        preferences,
        preferences.digestCount,
      );
      if (items.length > 0) {
        const rendered = renderDigestEmail({
          date: snapshot.date,
          pushTime: preferences.pushTime,
          abstract: snapshot.abstract,
          items,
          baseUrl,
          unsubToken: row.unsubToken,
        });
        await sendEmail({
          to: row.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: {
            'List-Unsubscribe': `<${unsubscribe}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        digestSent = true;
      }
    }
  } catch (err) {
    // 确认已生效；简报留给下一个整点 tick，不因发信失败让用户重走确认。
    console.error('immediate digest after confirmation failed:', err);
  }

  if (digestSent) {
    try {
      await db()
        .update(emailSubscribers)
        .set({
          lastSentAt: sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
        })
        .where(eq(emailSubscribers.id, row.id));
    } catch (err) {
      // 记失败最多导致当天再收一封，不影响订阅状态。
      console.error('lastSentAt after confirmation failed:', err);
    }
  }

  const message = digestSent
    ? '订阅成功，今日简报已发到你的邮箱。'
    : '订阅成功。今日简报会在下次推送时间送达。';
  sendHtml(res, 200, messagePage('订阅成功', message, links));
}
