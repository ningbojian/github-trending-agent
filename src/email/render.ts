import { BRAND } from '../brand.js';
import { escapeHtml } from '../http/html.js';
import type { DigestSnapshotItem } from '../agent/digest-snapshot.js';

/**
 * 品牌化每日简报邮件：内联样式 + table 布局 + 无外链图片/追踪像素。
 * 邮件展示订阅者条数设置内的全部条目（不套用企微的 3800 字节截断）。
 */

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

function renderItemHtml(index: number, item: DigestSnapshotItem): string {
  const c = BRAND.colors;
  const badges = [
    `<span style="display:inline-block;background:#f6f8fa;border:1px solid ${c.cardBorder};border-radius:999px;padding:2px 8px;font-size:12px;color:${c.text};">★ ${formatNumber(item.stars)}</span>`,
  ];
  if (item.starsDelta > 0) {
    badges.push(
      `<span style="display:inline-block;background:${c.growthBg};border-radius:999px;padding:2px 8px;font-size:12px;color:${c.growth};margin-left:6px;">+${formatNumber(item.starsDelta)} 今日</span>`,
    );
  }
  if (item.isNew) {
    badges.push(
      `<span style="display:inline-block;background:${c.growthBg};border-radius:999px;padding:2px 8px;font-size:12px;color:${c.growth};margin-left:6px;">新上榜</span>`,
    );
  }
  const url = item.htmlUrl || `https://github.com/${item.fullName}`;
  const summary = item.summary?.trim();
  return `<tr>
  <td style="padding:14px 0 14px 12px;border-bottom:1px solid #eaeef2;border-left:3px solid ${c.accent};">
    <div style="font-size:14px;color:${c.muted};">#${index}</div>
    <div style="margin-top:2px;">
      <a href="${escapeHtml(url)}" style="color:${c.link};text-decoration:none;font-family:${BRAND.monoFontFamily};font-size:15px;font-weight:600;">${escapeHtml(item.fullName)}</a>
    </div>
    <div style="margin-top:6px;">${badges.join('')}</div>
    ${summary ? `<div style="margin-top:8px;font-size:14px;line-height:1.6;color:${c.text};">${escapeHtml(summary)}</div>` : ''}
  </td>
</tr>`;
}

/** 渲染邮件（HTML + 纯文本双版本）。 */
export function renderDigestEmail(input: DigestEmailInput): RenderedEmail {
  const { date, pushTime, abstract, items, baseUrl, unsubToken } = input;
  const c = BRAND.colors;
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
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${c.pageBg};color:${c.text};font-family:${BRAND.fontFamily};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheaderText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.pageBg};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${BRAND.maxWidth}px;background:${c.cardBg};border:1px solid ${c.cardBorder};border-radius:12px;">
        <tr>
          <td style="background:${c.header};color:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0;">
            <div style="font-size:20px;font-weight:700;">${BRAND.name}</div>
            <div style="font-size:13px;color:#b1bac4;margin-top:2px;">${BRAND.subtitle} · ${escapeHtml(date)} · 北京时间 ${escapeHtml(pushTime)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 24px 8px;">
            <div style="font-size:15px;line-height:1.7;">你好，这是今天的 GitHub 热榜简报。</div>
            ${
              abstract
                ? `<div style="margin-top:10px;padding:12px 14px;background:#f6f8fa;border-left:3px solid ${c.link};border-radius:4px;font-size:14px;line-height:1.7;color:${c.text};">${escapeHtml(abstract)}</div>`
                : ''
            }
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${items.map((item, index) => renderItemHtml(index + 1, item)).join('\n')}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 24px 24px;color:${c.muted};font-size:12px;line-height:1.7;">
            <div>数据来源：GitHub Trending（近 7 天）。</div>
            <div style="margin-top:8px;">
              <a href="${escapeHtml(settings)}" style="color:${c.link};text-decoration:none;">调整推送时间 / 频率</a>
              &nbsp;·&nbsp;
              <a href="${escapeHtml(unsubscribe)}" style="color:${c.link};text-decoration:none;">退订</a>
            </div>
            <div style="margin-top:8px;">${BRAND.name} · 非 GitHub 官方产品</div>
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
