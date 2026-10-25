import { BRAND } from '../src/brand.js';
import { emailConfigured } from '../src/email/send.js';
import { escapeHtml, renderPage, sendHtml, type HtmlResponse } from '../src/http/html.js';
import { isWeComAccepting } from '../src/wecom/capacity.js';

/**
 * 触达入口落地页（GET /api/join）。
 * 顺序原则：先企微（成员 + 微信插件），邮箱入口始终可见；名额已满时邮箱升为推荐。
 */

export interface JoinRequest {
  method?: string;
}

export interface JoinPageOptions {
  accepting: boolean;
  emailReady: boolean;
  joinQrUrl?: string;
  pluginQrUrl?: string;
  appName: string;
}

function button(label: string, href: string | null): string {
  const c = BRAND.colors;
  if (href === null) {
    return `<div style="display:inline-block;padding:12px 20px;border-radius:8px;background:#eaeef2;color:${c.muted};font-size:15px;">${escapeHtml(label)}</div>`;
  }
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${c.accent};color:#ffffff;font-size:15px;text-decoration:none;font-weight:600;">${escapeHtml(label)}</a>`;
}

function badge(text: string): string {
  const c = BRAND.colors;
  return `<span style="display:inline-block;background:${c.accentSoft};color:${c.accent};border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;">${escapeHtml(text)}</span>`;
}

function card(title: string, body: string, options: { recommended?: boolean; muted?: boolean } = {}): string {
  const c = BRAND.colors;
  const border = options.muted ? c.cardBorder : c.accent;
  return `<div style="border:1px solid ${c.cardBorder};border-left:4px solid ${border};border-radius:10px;padding:18px 18px 20px;margin:0 0 16px;background:${options.muted ? '#fafbfc' : '#ffffff'};">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
    <div style="font-size:17px;font-weight:700;">${escapeHtml(title)}</div>
    ${options.recommended ? badge('推荐') : ''}
  </div>
  ${body}
</div>`;
}

function wecomCard(options: JoinPageOptions): string {
  const c = BRAND.colors;
  const steps = [
    '扫码加入企业（是否审核取决于管理员设置）。',
    `在微信里按提示启用「企业微信插件」。`,
    `在插件会话里给「${escapeHtml(options.appName)}」发一句「你好」，立即收到欢迎语和今日简报。`,
  ]
    .map(
      (step, index) =>
        `<li style="margin:6px 0;"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:${c.accentSoft};color:${c.accent};font-size:12px;font-weight:700;margin-right:8px;">${index + 1}</span>${step}</li>`,
    )
    .join('');

  const qr = [options.joinQrUrl, options.pluginQrUrl]
    .filter((url): url is string => Boolean(url))
    .map(
      (url) =>
        `<img src="${escapeHtml(url)}" alt="二维码" style="display:inline-block;width:132px;height:132px;margin:8px 12px 8px 0;border:1px solid ${c.cardBorder};border-radius:8px;">`,
    )
    .join('');

  return card(
    '在微信里每天收简报、随时提问',
    `<ul style="margin:0 0 12px;padding-left:0;list-style:none;font-size:14px;line-height:1.6;color:${c.text};">
      ${steps}
    </ul>
    ${qr ? `<div style="margin:4px 0 10px;">${qr}</div>` : ''}
    <div style="font-size:13px;color:${c.muted};line-height:1.7;">
      <div>· 每天自动收到 GitHub 热榜简报</div>
      <div>· 直接在微信里提问、收藏仓库并同步到 GitHub</div>
      <div>· 随时发「推送时间」调整收简报的时间</div>
      <div>· 全程在微信内完成，无需下载企业微信</div>
      <div style="margin-top:8px;">提示：把插件会话「置顶」，每天像看好友消息一样收简报。</div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px dashed ${c.cardBorder};font-size:13px;color:${c.muted};">
      如果加入时提示名额已满或无法加入，可直接用邮箱订阅。
    </div>`,
    { recommended: options.accepting },
  );
}

function emailCard(options: JoinPageOptions): string {
  const c = BRAND.colors;
  const body = options.emailReady
    ? `<div style="font-size:14px;line-height:1.7;color:${c.text};margin-bottom:12px;">
        <div>· 不用加入企业，任何邮箱都行</div>
        <div>· 每天一封，固定时间送达</div>
        <div>· 方便转发给同事</div>
      </div>
      ${button('用邮箱订阅', '/api/subscribe')}`
    : `<div style="font-size:14px;line-height:1.7;color:${c.muted};">
        邮箱订阅即将开放，敬请期待。
      </div>`;
  return card('只想收邮件？', body, {
    recommended: options.emailReady && !options.accepting,
  });
}

/** 渲染落地页（纯函数，供测试）。 */
export function renderJoinPage(options: JoinPageOptions): string {
  const c = BRAND.colors;
  const wecom = wecomCard(options);
  const email = emailCard(options);
  const cards = options.accepting ? `${wecom}${email}` : `${email}${wecom}`;
  const status = options.accepting
    ? ''
    : `<div style="margin-bottom:16px;padding:12px 14px;border-radius:8px;background:#fff8c5;color:#7d4e00;font-size:14px;line-height:1.6;">
        企微名额已满，暂不开放；邮箱订阅照常。
      </div>`;

  const body = `<div style="font-size:15px;line-height:1.7;color:${c.text};margin-bottom:18px;">
    每天一份中文 GitHub 热榜简报，两个入口任选其一。
  </div>
  ${status}
  ${cards}`;

  return renderPage({ title: '订阅 GitHub 热榜简报', body });
}

export default async function handler(
  req: JoinRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    sendHtml(
      res,
      405,
      renderPage({ title: '请求方式不支持', body: '<p>本页面仅支持 GET 请求。</p>' }),
    );
    return;
  }

  const accepting = await isWeComAccepting();
  const html = renderJoinPage({
    accepting,
    emailReady: emailConfigured(),
    joinQrUrl: process.env.WECOM_JOIN_QR_URL,
    pluginQrUrl: process.env.WECOM_PLUGIN_QR_URL,
    appName: process.env.WECOM_APP_NAME?.trim() || 'GitHub 热榜',
  });
  sendHtml(res, 200, html);
}
