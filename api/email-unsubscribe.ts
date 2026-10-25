import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { emailSubscribers } from '../src/db/schema.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { escapeHtml, renderPage, sendHtml, type HtmlResponse } from '../src/http/html.js';

/**
 * 邮箱退订（GET ?t=… 与 RFC 8058 一键退订 POST）。
 * 幂等：重复退订返回同样的成功页；未知 token → GET 404、POST 200（不泄露是否存在）。
 */

export interface UnsubscribeRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

function firstParam(
  query: UnsubscribeRequest['query'],
  name: string,
): string | undefined {
  const value = query?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single == null || single === '' ? undefined : single;
}

function donePage(baseUrl: string): string {
  return renderPage({
    title: '已退订',
    body: `<div style="font-size:14px;line-height:1.7;color:#1f2328;">你已不再收到 GitHub 热榜简报。</div>
    <div style="margin-top:16px;font-size:14px;">
      <a href="${escapeHtml(`${baseUrl}/api/subscribe`)}" style="color:#0969da;">重新订阅</a>
    </div>`,
  });
}

export default async function handler(
  req: UnsubscribeRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendHtml(res, 405, renderPage({ title: '请求方式不支持', body: '<p>本端点支持 GET / POST。</p>' }));
    return;
  }

  const baseUrl = resolveBaseUrl(req.headers);
  const token = firstParam(req.query, 't');

  if (method === 'POST') {
    // RFC 8058 一键退订：未知 token 也回 200，避免信息泄露；
    // 但写库失败必须回 5xx——报 200 会让邮件服务商认为退订已完成而不再重试，
    // 用户却仍在收信。
    let failed = false;
    if (token) {
      try {
        await db()
          .update(emailSubscribers)
          .set({ active: false })
          .where(eq(emailSubscribers.unsubToken, token));
      } catch (err) {
        console.error('one-click unsubscribe failed:', err);
        failed = true;
      }
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.status(failed ? 500 : 200).send(failed ? 'temporarily unavailable' : 'OK');
    return;
  }

  if (!token) {
    sendHtml(
      res,
      400,
      renderPage({ title: '链接无效', body: '<p>缺少退订参数，请从邮件页脚的链接进入。</p>' }),
    );
    return;
  }

  const row = (
    await db()
      .select()
      .from(emailSubscribers)
      .where(eq(emailSubscribers.unsubToken, token))
  )[0];
  if (!row) {
    sendHtml(res, 404, renderPage({ title: '链接无效', body: '<p>链接无效或已失效。</p>' }));
    return;
  }

  if (row.active) {
    await db()
      .update(emailSubscribers)
      .set({ active: false })
      .where(eq(emailSubscribers.id, row.id));
  }

  sendHtml(res, 200, donePage(baseUrl));
}
