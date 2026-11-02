import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { emailSubscribers } from '../src/db/schema.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { escapeHtml, sendHtml, type HtmlResponse } from '../src/http/html.js';
import { renderMessagePage } from '../src/ui/page.js';

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
  return renderMessagePage({
    title: '已退订',
    message: '你已不再收到 GitHub 热榜简报。',
    tone: 'ok',
    extraHtml: `<div class="p-actions">
      <a class="p-btn ghost" href="${escapeHtml(`${baseUrl}/api/subscribe`)}">重新订阅</a>
    </div>`,
  });
}

/**
 * 确认页：GET 不写库，只渲染一个「确认退订」按钮。
 * 邮件页脚的链接点开先到这里，避免误触一下就直接退订。
 */
function confirmPage(baseUrl: string, token: string): string {
  const action = `${baseUrl}/api/email-unsubscribe?t=${encodeURIComponent(token)}&confirm=1`;
  return renderMessagePage({
    title: '确认退订',
    message: '确定不再接收每日简报吗？',
    tone: 'warn',
    extraHtml: `<div class="p-actions">
      <form method="post" action="${escapeHtml(action)}">
        <button class="p-btn ghost" type="submit">确认退订</button>
      </form>
      <a class="p-btn" href="${escapeHtml(`${baseUrl}/api/email-settings?t=${encodeURIComponent(token)}`)}">保留订阅</a>
    </div>`,
  });
}

export default async function handler(
  req: UnsubscribeRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendHtml(
      res,
      405,
      renderMessagePage({
        title: '请求方式不支持',
        message: '本端点支持 GET / POST。',
        tone: 'err',
      }),
    );
    return;
  }

  const baseUrl = resolveBaseUrl(req.headers);
  const token = firstParam(req.query, 't');

  if (method === 'POST') {
    // 两种 POST：
    // - 我们自己的确认表单（?confirm=1）→ 退订后渲染「已退订」页
    // - RFC 8058 一键退订（邮件客户端）→ 纯文本 OK，不能要求二次确认
    const fromConfirmForm = firstParam(req.query, 'confirm') === '1';
    // 未知 token 也回 200，避免信息泄露；但写库失败必须回 5xx——
    // 报 200 会让邮件服务商认为退订已完成而不再重试，用户却仍在收信。
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
    if (failed) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.status(500).send('temporarily unavailable');
      return;
    }
    if (fromConfirmForm) {
      sendHtml(res, 200, donePage(baseUrl));
      return;
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.status(200).send('OK');
    return;
  }

  if (!token) {
    sendHtml(
      res,
      400,
      renderMessagePage({
        title: '链接无效',
        message: '缺少退订参数，请从邮件页脚的链接进入。',
        tone: 'err',
      }),
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
    sendHtml(
      res,
      404,
      renderMessagePage({ title: '链接无效', message: '链接无效或已失效。', tone: 'err' }),
    );
    return;
  }

  // GET 不写库：页脚链接先到确认页，避免误触一下就直接退订。
  if (row.active) {
    sendHtml(res, 200, confirmPage(baseUrl, token));
    return;
  }
  sendHtml(res, 200, donePage(baseUrl));
}
