import { emailConfigured } from '../src/email/send.js';
import { escapeHtml, sendHtml, type HtmlResponse } from '../src/http/html.js';
import { renderAppPage, renderMessagePage } from '../src/ui/page.js';
import { isWeComAccepting } from '../src/wecom/capacity.js';

/**
 * 触达入口落地页（GET /api/join）。
 * 顺序原则：先企微（成员 + 微信插件），邮箱入口始终可见；名额已满时邮箱升为推荐。
 *
 * 视觉：统一走 src/ui/page.ts 的页壳与 .p-* 原语，不再写内联样式；
 * 两张卡都是扁平 .p-card，避免「白卡套白卡」。
 */

/** 仓库内自带的二维码；环境变量可按需覆盖（例如换成企微后台新导出的邀请码）。 */
export const DEFAULT_JOIN_QR_URL = '/docs/assets/wecom-join-qr.png';
export const DEFAULT_PLUGIN_QR_URL = '/docs/assets/wecom-plugin-qr.png';

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
  if (href === null) {
    return `<span class="p-btn off">${escapeHtml(label)}</span>`;
  }
  return `<a class="p-btn" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function badge(text: string): string {
  return `<span class="p-badge accent">${escapeHtml(text)}</span>`;
}

function card(
  title: string,
  body: string,
  options: { recommended?: boolean } = {},
): string {
  return `<section class="p-card${options.recommended ? ' recommended' : ''}">
    <div class="p-card-head">
      <h2 class="p-section-title">${escapeHtml(title)}</h2>
      ${options.recommended ? badge('推荐') : ''}
    </div>
    ${body}
  </section>`;
}

function wecomCard(options: JoinPageOptions): string {
  const steps = [
    options.joinQrUrl
      ? '扫码加入企业（是否审核取决于管理员设置）。'
      : '向管理员索要企业邀请链接，加入后继续下一步。',
    '在微信里按提示启用「企业微信插件」。',
    `在插件会话里给「${escapeHtml(options.appName)}」发一句「你好」，立即收到欢迎语和今日简报。`,
  ]
    .map(
      (step, index) =>
        `<li class="p-step"><span class="p-step-num">${index + 1}</span><span>${step}</span></li>`,
    )
    .join('');

  // 两张二维码并排时长得一样，必须配图注，否则用户不知道先扫哪张。
  const qrTile = (url: string, caption: string): string =>
    `<div class="p-qr">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}二维码">
      <div class="p-qr-caption">${escapeHtml(caption)}</div>
    </div>`;

  const qr = [
    options.joinQrUrl ? qrTile(options.joinQrUrl, '加入企业') : '',
    options.pluginQrUrl ? qrTile(options.pluginQrUrl, '微信插件') : '',
  ].join('');

  return card(
    '在微信里每天收简报、随时提问',
    `<ul class="p-steps">${steps}</ul>
    ${qr ? `<div class="p-qr-grid">${qr}</div>` : ''}
    <div class="p-meta">
      <div>· 每天自动收到 GitHub 热榜简报</div>
      <div>· 直接在微信里提问、收藏仓库并同步到 GitHub</div>
      <div>· 随时发「推送时间」调整收简报的时间</div>
      <div>· 全程在微信内完成，无需下载企业微信</div>
    </div>
    <div class="p-note">
      提示：把插件会话「置顶」，每天像看好友消息一样收简报。
      如果加入时提示名额已满或无法加入，可直接用邮箱订阅。
    </div>`,
    { recommended: options.accepting },
  );
}

function emailCard(options: JoinPageOptions): string {
  const body = options.emailReady
    ? `<div class="p-meta">
        <div>· 不用加入企业，任何邮箱都行</div>
        <div>· 每天一封，固定时间送达</div>
        <div>· 方便转发给同事</div>
      </div>
      <div class="p-actions">${button('用邮箱订阅', '/api/subscribe')}</div>`
    : '<p class="p-meta">邮箱订阅即将开放，敬请期待。</p>';
  return card('只想收邮件？', body, {
    recommended: options.emailReady && !options.accepting,
  });
}

/** 渲染落地页（纯函数，供测试）。 */
export function renderJoinPage(options: JoinPageOptions): string {
  const wecom = wecomCard(options);
  const email = emailCard(options);
  const cards = options.accepting ? `${wecom}${email}` : `${email}${wecom}`;
  const status = options.accepting
    ? ''
    : '<div class="p-banner warn">企微名额已满，暂不开放；邮箱订阅照常。</div>';

  const body = `<p class="p-lead">每天一份中文 GitHub 热榜简报，两个入口任选其一。</p>
  ${status}
  ${cards}`;

  return renderAppPage({ title: '订阅 GitHub 热榜简报', body });
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
      renderMessagePage({
        title: '请求方式不支持',
        message: '本页面仅支持 GET 请求。',
        tone: 'err',
      }),
    );
    return;
  }

  const accepting = await isWeComAccepting();
  const html = renderJoinPage({
    accepting,
    emailReady: emailConfigured(),
    joinQrUrl: process.env.WECOM_JOIN_QR_URL?.trim() || DEFAULT_JOIN_QR_URL,
    pluginQrUrl: process.env.WECOM_PLUGIN_QR_URL?.trim() || DEFAULT_PLUGIN_QR_URL,
    appName: process.env.WECOM_APP_NAME?.trim() || 'GitHub 热榜',
  });
  sendHtml(res, 200, html);
}
