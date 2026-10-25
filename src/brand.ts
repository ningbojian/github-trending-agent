/**
 * 品牌视觉常量：落地页 / 表单页 / 邮件模板共用。
 * 邮件全部内联样式 + table 布局 + 无外链图片（图片默认被屏蔽且影响送达率）。
 */

export const BRAND = {
  name: 'GitHub 热榜',
  subtitle: '每日简报',
  colors: {
    header: '#0d1117',
    text: '#1f2328',
    muted: '#656d76',
    green: '#1a7f37',
    greenBg: '#dafbe1',
    link: '#0969da',
    pageBg: '#f6f8fa',
    cardBg: '#ffffff',
    cardBorder: '#d0d7de',
  },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  monoFontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  maxWidth: 640,
} as const;

/**
 * 品牌图标：深底 + 绿色对话气泡 + 白色上升折线（原创几何图形，不含第三方素材）。
 * - 只用 <path>/<rect>，无文字、无外链，24px 与圆形裁切下都能认出；
 * - 落地页内联使用，不产生额外请求；源文件在 docs/assets/icon.svg，
 *   企微后台用的 750px PNG 由同一造型导出（docs/assets/icon-750.png）。
 * - 邮件刻意不使用图片：外链图片会被客户端屏蔽并影响送达率。
 */
export const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="40" height="40" role="img" aria-hidden="true" data-brand="logo"><defs><linearGradient id="brandGrad" gradientUnits="userSpaceOnUse" x1="128" y1="148" x2="392" y2="392"><stop offset="0" stop-color="#2ea043"/><stop offset="1" stop-color="#1a7f37"/></linearGradient></defs><rect width="512" height="512" fill="#0d1117"/><path d="M156 306 L156 386 Q156 408 176 398 L246 358 Z" fill="url(#brandGrad)"/><rect x="96" y="136" width="320" height="232" rx="62" fill="url(#brandGrad)"/><path d="M164 310 L228 244 L272 292 L314 240" fill="none" stroke="#ffffff" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><path d="M348 188 L360 262 L282 210 Z" fill="#ffffff" stroke="#ffffff" stroke-width="8" stroke-linejoin="round"/></svg>`;

/** favicon：同一图形的 data URI（内联，无静态文件依赖）。 */
export const BRAND_FAVICON = `data:image/svg+xml,${encodeURIComponent(BRAND_ICON_SVG)}`;
