import { BRAND } from '../brand.js';
import { escapeHtml } from '../http/html.js';
import type { DigestSnapshotItem } from '../agent/digest-snapshot.js';

/**
 * 品牌化每日简报邮件：内联样式 + table 布局 + 无外链图片/追踪像素。
 * 邮件展示订阅者条数设置内的全部条目（不套用企微的 1900 字节截断）。
 *
 * 视觉：与网页同一套深墨夜景（`#0B1220` 底 + 青色强调）。邮件客户端不支持
 * 半透明与毛玻璃，所以这里全部用**实色**：卡片 `#141A24`、描边 `#25303D`、
 * 正文 `#E8EEF5`。声明 `color-scheme: dark light`，系统深色模式不会把配色翻掉。
 */

/**
 * 邮件专用实色板。网页那套 rgba 在 Outlook / QQ 邮件里会被降级成白底，
 * 所以这里不复用 `BRAND.dark` 的半透明值，只用它的强调色。
 */
const EMAIL = {
  /** 页面底：比网页的 #0B1220 亮一档，纯黑在邮件里显得闷。 */
  page: '#141922',
  card: '#1B222C',
  cardBorder: '#303A47',
  headerBg: '#202834',
  text: '#E9EEF5',
  /** 条目简介：比标题暗一档，读起来有层次但不费劲。 */
  summary: '#C9D4E0',
  muted: '#A2ADBB',
  faint: '#8A95A4',
  accent: BRAND.dark.accent,
  divider: '#2A3442',
  pillBg: '#26303D',
  pillBorder: '#36414F',
  pillText: '#CBD5E1',
  growthBg: '#173328',
  growthText: '#6EE7A8',
  abstractBg: '#212B38',
  abstractText: '#D6E0EB',
} as const;

export interface DigestEmailInput {
  date: string;
  /** 北京时间整点（HH:MM）。 */
  pushTime: string;
  abstract: string | null;
  items: DigestSnapshotItem[];
  /** 站点根地址（无尾斜杠），用于设置/退订链接。 */
  baseUrl: string;
  unsubToken: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 主题固定格式：`GitHub 热榜简报 · 10-25`（无 emoji、无营销词）。 */
export function emailSubject(date: string): string {
  const parts = date.split('-');
  const monthDay = parts.length === 3 ? `${parts[1]}-${parts[2]}` : date;
  return `${BRAND.name}简报 · ${monthDay}`;
}

function settingsUrl(baseUrl: string, unsubToken: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/email-settings?t=${encodeURIComponent(unsubToken)}`;
}

function unsubscribeUrl(baseUrl: string, unsubToken: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/email-unsubscribe?t=${encodeURIComponent(unsubToken)}`;
}

/** 深色胶囊：实色底 + 细描边，Outlook 也能画出边界。 */
function pill(text: string, tone: 'default' | 'growth' = 'default'): string {
  const bg = tone === 'growth' ? EMAIL.growthBg : EMAIL.pillBg;
  const fg = tone === 'growth' ? EMAIL.growthText : EMAIL.pillText;
  const border = tone === 'growth' ? 'transparent' : EMAIL.pillBorder;
  return `<span style="display:inline-block;background:${bg};border:1px solid ${border};border-radius:999px;padding:1px 7px;margin:0 4px 2px 0;font-size:11px;line-height:1.5;color:${fg};">${text}</span>`;
}

/** 单条：序号与仓库名一行，徽章一行，简介一行——比原来拆成四行紧一档。 */
function renderItemHtml(index: number, item: DigestSnapshotItem, last: boolean): string {
  const badges = [pill(`★ ${formatNumber(item.stars)}`)];
  if (item.starsDelta > 0) badges.push(pill(`+${formatNumber(item.starsDelta)} 今日`, 'growth'));
  if (item.isNew) badges.push(pill('新上榜', 'growth'));
  const url = item.htmlUrl || `https://github.com/${item.fullName}`;
  const summary = item.summary?.trim();
  return `<tr>
  <td style="padding:8px 0;${last ? '' : `border-bottom:1px solid ${EMAIL.divider};`}">
    <div style="font-size:14px;line-height:1.4;">
      <span style="color:${EMAIL.faint};font-size:12px;margin-right:6px;">#${index}</span><a href="${escapeHtml(url)}" style="color:${EMAIL.accent};text-decoration:none;font-family:${BRAND.monoFontFamily};font-size:14px;font-weight:600;">${escapeHtml(item.fullName)}</a>
    </div>
    <div style="margin-top:2px;">${badges.join('')}</div>
    ${summary ? `<div style="margin-top:3px;font-size:13px;line-height:1.55;color:${EMAIL.summary};">${escapeHtml(summary)}</div>` : ''}
  </td>
</tr>`;
}

/** 渲染邮件（HTML + 纯文本双版本）。 */
export function renderDigestEmail(input: DigestEmailInput): RenderedEmail {
  const { date, pushTime, abstract, items, baseUrl, unsubToken } = input;
  const subject = emailSubject(date);
  const settings = settingsUrl(baseUrl, unsubToken);
  const unsubscribe = unsubscribeUrl(baseUrl, unsubToken);

  const preheaderText =
    items.length > 0
      ? `今日 ${items.length} 个热榜项目：${items.slice(0, 3).map((item) => item.fullName).join('、')}`
      : '今日暂无热榜项目';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escapeHtml(subject)}</title>
</head>
<body bgcolor="${EMAIL.page}" style="margin:0;padding:0;background:${EMAIL.page};color:${EMAIL.text};font-family:${BRAND.fontFamily};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheaderText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${EMAIL.page}" style="background:${EMAIL.page};padding:16px 10px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${BRAND.maxWidth}px;background:${EMAIL.card};border:1px solid ${EMAIL.cardBorder};border-radius:14px;">
        <tr>
          <td style="background:${EMAIL.headerBg};border-bottom:1px solid ${EMAIL.cardBorder};border-radius:14px 14px 0 0;padding:12px 16px;">
            <div style="font-size:17px;font-weight:700;letter-spacing:.2px;">${BRAND.name}</div>
            <div style="margin-top:2px;font-size:12px;color:${EMAIL.muted};">${BRAND.subtitle} · ${escapeHtml(date)} · 北京时间 ${escapeHtml(pushTime)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 16px 0;">
            <div style="font-size:13px;line-height:1.6;color:${EMAIL.muted};">你好，这是今天的 GitHub 热榜简报。</div>
            ${
              abstract
                ? `<div style="margin-top:8px;padding:9px 12px;background:${EMAIL.abstractBg};border-left:2px solid ${EMAIL.accent};border-radius:6px;font-size:13px;line-height:1.6;color:${EMAIL.abstractText};">${escapeHtml(abstract)}</div>`
                : ''
            }
          </td>
        </tr>
        <tr>
          <td style="padding:4px 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${items.map((item, index) => renderItemHtml(index + 1, item, index === items.length - 1)).join('\n')}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 16px 14px;border-top:1px solid ${EMAIL.divider};color:${EMAIL.muted};font-size:12px;line-height:1.6;">
            <div>数据来源：GitHub Trending（近 7 天）。</div>
            <div style="margin-top:5px;">
              <a href="${escapeHtml(settings)}" style="color:${EMAIL.accent};text-decoration:none;">调整推送时间 / 频率</a>
              &nbsp;·&nbsp;
              <a href="${escapeHtml(unsubscribe)}" style="color:${EMAIL.muted};text-decoration:none;">退订</a>
            </div>
            <div style="margin-top:5px;color:${EMAIL.faint};">${BRAND.name} · 非 GitHub 官方产品</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const textLines = [
    `你好，这是今天的 GitHub 热榜简报（${date}）。`,
    '',
    ...(abstract ? [abstract, ''] : []),
    ...items.flatMap((item, index) => {
      const meta = [`★ ${formatNumber(item.stars)}`, `+${formatNumber(item.starsDelta)} 今日`];
      if (item.isNew) meta.push('新上榜');
      const summary = item.summary?.trim();
      return [
        `${index + 1}. ${item.fullName}（${meta.join(' / ')}）`,
        item.htmlUrl || `https://github.com/${item.fullName}`,
        ...(summary ? [summary] : []),
        '',
      ];
    }),
    `调整推送时间 / 频率：${settings}`,
    `退订：${unsubscribe}`,
    '',
    `${BRAND.name} · 非 GitHub 官方产品`,
  ];

  return { subject, text: textLines.join('\n'), html };
}

// ---------------------------------------------------------------------------
// 确认信 / 管理信：同一套 table + 内联样式纪律，不套网页页壳
// ---------------------------------------------------------------------------

/** 邮件里的主按钮：用 table 单元格包 <a>，Outlook 才不丢 padding。 */
function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 0;">
  <tr>
    <td style="background:${EMAIL.accent};border-radius:8px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:700;color:#06222A;text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/** 邮件骨架：隐藏 preheader + table 布局 + 品牌头 + 页脚。 */
function renderEmailDocument(input: {
  title: string;
  preheader: string;
  subtitle: string;
  bodyHtml: string;
  footerHtml?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escapeHtml(input.title)}</title>
</head>
<body bgcolor="${EMAIL.page}" style="margin:0;padding:0;background:${EMAIL.page};color:${EMAIL.text};font-family:${BRAND.fontFamily};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${EMAIL.page}" style="background:${EMAIL.page};padding:16px 10px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${BRAND.maxWidth}px;background:${EMAIL.card};border:1px solid ${EMAIL.cardBorder};border-radius:14px;">
        <tr>
          <td style="background:${EMAIL.headerBg};border-bottom:1px solid ${EMAIL.cardBorder};border-radius:14px 14px 0 0;padding:12px 16px;">
            <div style="font-size:17px;font-weight:700;letter-spacing:.2px;">${BRAND.name}</div>
            <div style="margin-top:2px;font-size:12px;color:${EMAIL.muted};">${escapeHtml(input.subtitle)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px 10px;">${input.bodyHtml}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px 14px;border-top:1px solid ${EMAIL.divider};color:${EMAIL.muted};font-size:12px;line-height:1.6;">
            ${input.footerHtml ?? ''}
            <div style="margin-top:5px;color:${EMAIL.faint};">${BRAND.name} · 非 GitHub 官方产品</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** 确认订阅 / 恢复订阅邮件。 */
export function renderConfirmEmail(input: {
  subject: string;
  lead: string;
  confirmUrl: string;
  actionLabel: string;
}): string {
  const body = `<div style="font-size:14px;line-height:1.65;">${escapeHtml(input.lead)}链接 48 小时内有效。</div>
${emailButton(input.confirmUrl, input.actionLabel)}
<div style="margin-top:14px;font-size:12px;color:${EMAIL.muted};line-height:1.6;">如果这不是你本人操作，忽略本邮件即可。</div>`;
  return renderEmailDocument({
    title: input.subject,
    preheader: input.subject,
    subtitle: '邮箱订阅',
    bodyHtml: body,
  });
}

/** 管理邮件：设置 / 退订链接（长期 token，只走邮件）。 */
export function renderManageEmail(input: {
  settingsUrl: string;
  unsubscribeUrl: string;
}): string {
  const body = `<div style="font-size:14px;line-height:1.65;">你好，这是你的 GitHub 热榜简报订阅管理链接。</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;">
  <tr>
    <td style="padding:0 0 8px;font-size:14px;">
      <a href="${escapeHtml(input.settingsUrl)}" style="color:${EMAIL.accent};text-decoration:none;">调整推送时间 / 频率</a>
    </td>
  </tr>
  <tr>
    <td style="font-size:14px;">
      <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${EMAIL.muted};text-decoration:none;">退订</a>
    </td>
  </tr>
</table>
<div style="margin-top:14px;font-size:12px;color:${EMAIL.muted};line-height:1.6;">如果这不是你本人操作，忽略本邮件即可。</div>`;
  return renderEmailDocument({
    title: '订阅管理',
    preheader: '订阅管理链接',
    subtitle: '邮箱订阅',
    bodyHtml: body,
  });
}
