/**
 * 品牌视觉常量：落地页 / 表单页 / 邮件模板共用。
 * 邮件全部内联样式 + table 布局 + 无外链图片（图片默认被屏蔽且影响送达率）。
 */

export const BRAND = {
  name: 'GitHub 热榜',
  subtitle: '每日简报',
  colors: {
    header: '#0B1220',
    /** 白底上的品牌主色（按钮 / 链接 / 卡片左描边）；白底对比度 5.2:1。 */
    accent: '#2563EB',
    /** 徽章、步骤序号的底色。 */
    accentSoft: '#DBEAFE',
    /** 浅蓝底上的深蓝文字（徽章/步骤序号）。 */
    accentInk: '#1d4ed8',
    /** 页面顶部径向渐变的起点。 */
    accentWash: '#e7efff',
    /** 深色底上渐变起点。 */
    accentBright: '#3B82F6',
    /** 深色底上渐变终点 / 天线点 / 高光。 */
    accentCyan: '#22D3EE',
    text: '#1f2328',
    muted: '#656d76',
    link: '#2563EB',
    pageBg: '#f6f8fa',
    cardBg: '#ffffff',
    /** 主卡片渐变的第二段（近白冷调）。 */
    cardAlt: '#f7f9fc',
    cardBorder: '#d0d7de',
    /** 浅灰分组块（卡片内的 section）。 */
    soft: '#eef2f7',
    /** 分隔线 / 禁用态底色。 */
    divider: '#eaeef2',
    onHeader: '#ffffff',
    headerMuted: '#b1bac4',
    danger: '#cf222e',
    dangerBg: '#ffebe9',
    warn: '#7d4e00',
    warnBg: '#fff8c5',
    /** 数据语义色：GitHub 的增长绿，只用于「+N 今日 / 新上榜」，不是品牌色。 */
    growth: '#1a7f37',
    growthBg: '#dafbe1',
  },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  monoFontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  maxWidth: 640,
  /**
   * 深色玻璃主题：所有网页（面板、join、订阅、邮箱设置、metrics、trace、OAuth）
   * 共用这一套。邮件仍是浅色——邮件客户端不支持半透明与毛玻璃，另有一套模板。
   */
  dark: {
    /** 页面底色：深墨夜景。 */
    pageBg: '#101318',
    /** 页壳/主卡片底色：半透明深墨，叠在页面光源上。 */
    cardBg: 'rgba(16,19,24,.66)',
    cardBorder: 'rgba(255,255,255,.12)',
    text: 'rgba(255,255,255,.95)',
    muted: 'rgba(255,255,255,.68)',
    /** 页脚等最弱的一层文字。 */
    faint: 'rgba(255,255,255,.55)',
    line: 'rgba(255,255,255,.14)',
    /** 表单控件描边：比普通分隔线更实，否则输入框边界只有 1.2:1。 */
    fieldLine: 'rgba(255,255,255,.32)',
    /** 输入框占位文字：低于正文但仍在 4.5:1 以上。 */
    placeholder: 'rgba(255,255,255,.55)',
    /** 卡片内部的浅色玻璃层。 */
    soft: 'rgba(255,255,255,.055)',
    /** 浮起的瓦片、输入框、徽章底色。 */
    card: 'rgba(255,255,255,.09)',
    /** 强调色：深底上用青色，蓝字在白底才够对比。 */
    accent: '#22D3EE',
    accentSoft: 'rgba(34,211,238,.14)',
    accentInk: '#A5F3FC',
    ok: '#3FB950',
    okBg: 'rgba(63,185,80,.14)',
    danger: '#FF6B6B',
    dangerBg: 'rgba(255,107,107,.12)',
    warn: '#E4B863',
    warnBg: 'rgba(228,184,99,.12)',
    divider: 'rgba(255,255,255,.10)',
    /** 页面顶部/底部的两团光源。 */
    glowCyan: 'rgba(34,211,238,.12)',
    glowBlue: 'rgba(59,130,246,.14)',
  },
} as const;

/**
 * 品牌图标：深底上的「气泡机器人」——对话气泡做头，长出天线、圆眼与微笑。
 * - 只用 <path>/<rect>/<circle>，无文字、无外链；24px 与圆形裁切下都能认出；
 * - 落地页内联使用，不产生额外请求；源文件在 docs/assets/icon.svg，
 *   企微后台用的 750px PNG 由同一造型导出（docs/assets/icon-750.png）。
 * - 邮件刻意不使用图片：外链图片会被客户端屏蔽并影响送达率。
 */
export const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="40" height="40" role="img" aria-hidden="true" data-brand="logo"><defs><linearGradient id="brandGrad" gradientUnits="userSpaceOnUse" x1="112" y1="150" x2="400" y2="380"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#2563EB"/></linearGradient></defs><rect width="512" height="512" fill="#0B1220"/><g transform="rotate(-5 256 268)"><circle cx="256" cy="88" r="27" fill="#22D3EE" opacity="0.18"/><rect x="248" y="96" width="16" height="60" rx="8" fill="#3B82F6"/><circle cx="256" cy="88" r="19" fill="#22D3EE"/><path d="M176 348 L150 416 Q147 426 161 419 L246 378 Z" fill="url(#brandGrad)"/><rect x="112" y="150" width="288" height="230" rx="70" fill="url(#brandGrad)"/><circle cx="204" cy="252" r="29" fill="#ffffff"/><circle cx="308" cy="252" r="29" fill="#ffffff"/><circle cx="204" cy="259" r="13" fill="#0B1220"/><circle cx="308" cy="259" r="13" fill="#0B1220"/><path d="M214 316 Q256 342 298 316" fill="none" stroke="#ffffff" stroke-width="14" stroke-linecap="round"/></g></svg>`;

/** favicon：同一图形的 data URI（内联，无静态文件依赖）。 */
export const BRAND_FAVICON = `data:image/svg+xml,${encodeURIComponent(BRAND_ICON_SVG)}`;
