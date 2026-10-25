import { BRAND, BRAND_FAVICON, BRAND_ICON_SVG } from '../brand.js';

/**
 * 落地页 / 表单页的 HTML 工具。
 * - escapeHtml 用于所有动态文本（含属性值中的引号）
 * - renderPage 统一品牌头、viewport、移动端优先的卡片布局
 */

/** Vercel res 的最小形态（不引入 @vercel/node 依赖）。 */
export interface HtmlResponse {
  status(code: number): HtmlResponse;
  setHeader(name: string, value: string): HtmlResponse | void;
  send(body: string): unknown;
}

/** 转义 HTML 文本与属性值（引号一并转义，可安全用于 href/title）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderPageOptions {
  title: string;
  /** 页面主体 HTML（调用方负责转义动态文本）。 */
  body: string;
  /** 页面副标题（如日期）。 */
  subtitle?: string;
}

/** 渲染完整 HTML 页面（viewer 端：手机优先）。 */
export function renderPage(options: RenderPageOptions): string {
  const { title, body, subtitle } = options;
  const c = BRAND.colors;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${BRAND_FAVICON}">
</head>
<body style="margin:0;padding:0;background:${c.pageBg};color:${c.text};font-family:${BRAND.fontFamily};-webkit-text-size-adjust:100%;">
<div style="max-width:${BRAND.maxWidth}px;margin:0 auto;padding:20px 16px 40px;">
  <div style="background:${c.header};color:#ffffff;border-radius:12px 12px 0 0;padding:20px 24px;display:flex;align-items:center;gap:12px;">
    <div style="width:40px;height:40px;flex:0 0 40px;border-radius:10px;overflow:hidden;">${BRAND_ICON_SVG}</div>
    <div>
      <div style="font-size:20px;font-weight:700;letter-spacing:0.2px;">${BRAND.name}</div>
      <div style="font-size:13px;color:#b1bac4;margin-top:2px;">${BRAND.subtitle}${subtitle ? ` · ${escapeHtml(subtitle)}` : ''}</div>
    </div>
  </div>
  <div style="background:${c.cardBg};border:1px solid ${c.cardBorder};border-top:0;border-radius:0 0 12px 12px;padding:24px;">
    <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(title)}</h1>
    ${body}
  </div>
  <div style="text-align:center;color:${c.muted};font-size:12px;margin-top:16px;">
    ${BRAND.name} · 非 GitHub 官方产品
  </div>
</div>
</body>
</html>`;
}

/** 发送 HTML 响应。 */
export function sendHtml(
  res: HtmlResponse,
  status: number,
  html: string,
): void {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}
