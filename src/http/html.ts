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
  /** 额外 CSS（可信的静态字符串，不接受用户输入）。 */
  styles?: string;
  /** 页面外层背景（CSS background 值）；缺省品牌浅灰。 */
  pageBg?: string;
  /** 主卡片背景（CSS background 值）；缺省纯白。 */
  cardBg?: string;
  /** 主卡片边框色；缺省品牌边框。 */
  cardBorder?: string;
  /** 页面正文颜色；缺省品牌深色文字。 */
  textColor?: string;
  /** 页脚颜色；缺省品牌次要文字。 */
  footerColor?: string;
  /** 主卡片内边距；缺省 24px。 */
  cardPadding?: string;
  /** 品牌头额外 class（用于按页面补样式）。 */
  headerClass?: string;
  /** 包裹头部与卡片的容器 class（如加投影）。 */
  shellClass?: string;
  /** 容器圆角；缺省 12px。 */
  shellRadius?: string;
}

/** 渲染完整 HTML 页面（viewer 端：手机优先）。 */
export function renderPage(options: RenderPageOptions): string {
  const {
    title,
    body,
    subtitle,
    styles,
    pageBg,
    cardBg,
    cardBorder,
    textColor,
    footerColor,
    cardPadding,
    headerClass,
    shellClass,
    shellRadius,
  } = options;
  const c = BRAND.colors;
  const d = BRAND.dark;
  // 品牌头全站一档：面板、join、订阅、邮箱设置、metrics、trace 共用同一组尺寸。
  // 28px 图标 + 17px 标题，手机首屏能多留出一行内容。
  const headerPad = '12px 16px';
  const headerGap = '10px';
  const iconSize = '28px';
  const iconRadius = '8px';
  const titleSize = '17px';
  const subtitleSize = '12px';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${c.header}">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${BRAND_FAVICON}">
${styles ? `<style>${styles}</style>` : ''}
</head>
<body style="margin:0;padding:0;background:${pageBg ?? d.pageBg};color:${textColor ?? d.text};font-family:${BRAND.fontFamily};-webkit-text-size-adjust:100%;">
<div style="max-width:${BRAND.maxWidth}px;margin:0 auto;padding:20px 16px calc(40px + env(safe-area-inset-bottom));">
  <div class="${shellClass ?? ''}" style="border-radius:${shellRadius ?? '12px'};overflow:hidden;">
  <div class="${headerClass ?? ''}" style="background:${c.header};color:${c.onHeader};padding:${headerPad};display:flex;align-items:center;gap:${headerGap};">
    <div class="p-header-icon" style="width:${iconSize};height:${iconSize};flex:0 0 ${iconSize};border-radius:${iconRadius};overflow:hidden;">${BRAND_ICON_SVG}</div>
    <div>
      <div class="p-header-title" style="font-size:${titleSize};font-weight:700;letter-spacing:0.2px;line-height:1.25;">${BRAND.name}</div>
      <div class="p-header-sub" style="font-size:${subtitleSize};color:${c.headerMuted};margin-top:2px;line-height:1.35;">${BRAND.subtitle}${subtitle ? ` · ${escapeHtml(subtitle)}` : ''}</div>
    </div>
  </div>
  <div style="background:${cardBg ?? d.cardBg};border:1px solid ${cardBorder ?? d.cardBorder};border-top:0;padding:${cardPadding ?? '24px'};">
    <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(title)}</h1>
    ${body}
  </div>
  </div>
  <div style="text-align:center;color:${footerColor ?? d.faint};font-size:12px;margin-top:16px;">
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
