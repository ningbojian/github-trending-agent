import { eq } from 'drizzle-orm';
import { BRAND } from '../src/brand.js';
import { db } from '../src/db/client.js';
import { emailSubscribers } from '../src/db/schema.js';
import {
  EMAIL_DIGEST_COUNTS,
  EMAIL_INTERVALS,
  EMAIL_PUSH_TIMES,
  normalizeEmailPreferences,
  validateEmailPreferencesInput,
  type EmailPreferences,
} from '../src/email/preferences.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { readBodyFields, readBodyFieldsAll } from '../src/http/body.js';
import { escapeHtml, renderPage, sendHtml, type HtmlResponse } from '../src/http/html.js';
import { SCRAPER_LANGUAGES } from '../src/config.js';

/**
 * 邮箱订阅设置（GET 表单 / POST 保存，凭证是长期有效的 unsubToken）。
 * 越界值回错误提示；未知 token → 404 零写入。
 */

export interface SettingsRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

function firstParam(
  query: SettingsRequest['query'],
  name: string,
): string | undefined {
  const value = query?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single == null || single === '' ? undefined : single;
}

function languageLabel(slug: string): string {
  if (slug === 'c++') return 'C++';
  if (slug === 'c#') return 'C#';
  if (slug === 'html') return 'HTML';
  if (slug === 'css') return 'CSS';
  if (slug === 'php') return 'PHP';
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function select(
  name: string,
  options: Array<{ value: string; label: string }>,
  current: string,
): string {
  return `<select name="${escapeHtml(name)}" style="width:100%;box-sizing:border-box;padding:11px 12px;font-size:16px;border:1px solid #d0d7de;border-radius:8px;background:#ffffff;">
    ${options
      .map(
        (option) =>
          `<option value="${escapeHtml(option.value)}"${option.value === current ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
      )
      .join('')}
  </select>`;
}

function form(options: {
  token: string;
  preferences: EmailPreferences;
  error?: string;
  notice?: string;
  baseUrl: string;
  inactive: boolean;
}): string {
  const { token, preferences } = options;
  const error = options.error
    ? `<div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:#ffebe9;color:#cf222e;font-size:14px;">${escapeHtml(options.error)}</div>`
    : '';
  const notice = options.notice
    ? `<div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:${BRAND.colors.accentSoft};color:${BRAND.colors.accent};font-size:14px;">${escapeHtml(options.notice)}</div>`
    : '';
  const inactive = options.inactive
    ? `<div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:#fff8c5;color:#7d4e00;font-size:14px;">当前处于退订状态，保存设置不会自动恢复订阅。</div>`
    : '';

  const languages = (SCRAPER_LANGUAGES as readonly string[])
    .map(
      (slug) =>
        `<label style="display:inline-flex;align-items:center;gap:6px;margin:4px 12px 4px 0;font-size:14px;">
          <input type="checkbox" name="languages" value="${escapeHtml(slug)}"${preferences.languages.includes(slug) ? ' checked' : ''}>
          ${escapeHtml(languageLabel(slug))}
        </label>`,
    )
    .join('');

  const unsubscribe = `${options.baseUrl}/api/email-unsubscribe?t=${encodeURIComponent(token)}`;

  return renderPage({
    title: '邮箱订阅设置',
    body: `${error}${notice}${inactive}
    <form method="post" action="/api/email-settings?t=${encodeURIComponent(token)}">
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:14px;margin-bottom:6px;">推送时间（北京时间）</label>
        ${select(
          'pushTime',
          EMAIL_PUSH_TIMES.map((time) => ({ value: time, label: time })),
          preferences.pushTime,
        )}
      </div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:14px;margin-bottom:6px;">推送间隔</label>
        ${select(
          'intervalDays',
          EMAIL_INTERVALS.map((days) => ({
            value: String(days),
            label: days === 1 ? '每天' : `每 ${days} 天`,
          })),
          String(preferences.intervalDays),
        )}
      </div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:14px;margin-bottom:6px;">每次简报条数</label>
        ${select(
          'digestCount',
          EMAIL_DIGEST_COUNTS.map((count) => ({
            value: String(count),
            label: `${count} 条`,
          })),
          String(preferences.digestCount),
        )}
      </div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:14px;margin-bottom:6px;">关注方向（不选 = 全部）</label>
        <div>${languages}</div>
      </div>
      <div style="margin-bottom:18px;">
        <label style="display:block;font-size:14px;margin-bottom:6px;">关键词（用逗号分隔，可留空）</label>
        <input name="keywords" type="text" value="${escapeHtml(preferences.keywords.join(', '))}"
          style="width:100%;box-sizing:border-box;padding:12px 14px;font-size:16px;border:1px solid #d0d7de;border-radius:8px;">
      </div>
      <button type="submit" style="width:100%;padding:12px 20px;font-size:16px;border:0;border-radius:8px;background:${BRAND.colors.accent};color:#ffffff;font-weight:600;">保存设置</button>
    </form>
    <div style="margin-top:18px;font-size:14px;">
      <a href="${escapeHtml(unsubscribe)}" style="color:#656d76;">退订</a>
    </div>`,
  });
}

export default async function handler(
  req: SettingsRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendHtml(res, 405, renderPage({ title: '请求方式不支持', body: '<p>本端点支持 GET / POST。</p>' }));
    return;
  }

  const token = firstParam(req.query, 't');
  if (!token) {
    sendHtml(
      res,
      400,
      renderPage({ title: '链接无效', body: '<p>缺少设置参数，请从邮件页脚的链接进入。</p>' }),
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

  const baseUrl = resolveBaseUrl(req.headers);
  const current = normalizeEmailPreferences(row.preferences);

  if (method === 'GET') {
    sendHtml(
      res,
      200,
      form({ token, preferences: current, baseUrl, inactive: !row.active }),
    );
    return;
  }

  const all = readBodyFieldsAll(req.body);
  const fields = readBodyFields(req.body);
  const validated = validateEmailPreferencesInput({
    pushTime: fields.pushTime,
    intervalDays: fields.intervalDays,
    digestCount: fields.digestCount,
    languages: all.languages ?? [],
    keywords: fields.keywords,
  });
  if (!validated.ok) {
    sendHtml(
      res,
      400,
      form({
        token,
        preferences: current,
        error: validated.error,
        baseUrl,
        inactive: !row.active,
      }),
    );
    return;
  }

  await db()
    .update(emailSubscribers)
    .set({ preferences: validated.preferences })
    .where(eq(emailSubscribers.id, row.id));

  sendHtml(
    res,
    200,
    form({
      token,
      preferences: validated.preferences,
      notice: '设置已保存。',
      baseUrl,
      inactive: !row.active,
    }),
  );
}
