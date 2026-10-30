import { escapeHtml, renderPage } from '../http/html.js';
import { POINTER_SCRIPT } from './pointer.js';
import {
  APP_CARD_BG,
  APP_CARD_BORDER,
  APP_FOOTER,
  APP_PAGE_BG,
  APP_TEXT,
} from './tokens.js';
import { BASE_STYLES } from './styles.js';

/**
 * 统一页壳：所有新迁移的网页都从这里渲染。
 *
 * 与 renderPage 的关系：renderPage 保持原接口和「不传 styles 不输出 <style>」
 * 的语义；renderAppPage 固定注入 BASE_STYLES、深墨玻璃主题与指针柔光脚本。
 */

export interface AppPageOptions {
  title: string;
  body: string;
  subtitle?: string;
  /** 页面专属的额外 CSS（可信静态字符串）。 */
  extraStyles?: string;
  pageBg?: string;
  cardBg?: string;
  cardBorder?: string;
  shellClass?: string;
  /** 主卡片圆角；缺省 20px（与面板同一档）。 */
  shellRadius?: string;
}

export function renderAppPage(options: AppPageOptions): string {
  return renderPage({
    title: options.title,
    body: `${options.body}<script>${POINTER_SCRIPT}</script>`,
    subtitle: options.subtitle,
    styles: BASE_STYLES + (options.extraStyles ?? ''),
    pageBg: options.pageBg ?? APP_PAGE_BG,
    cardBg: options.cardBg ?? APP_CARD_BG,
    cardBorder: options.cardBorder ?? APP_CARD_BORDER,
    textColor: APP_TEXT,
    footerColor: APP_FOOTER,
    shellClass: options.shellClass ?? 'app-shell',
    shellRadius: options.shellRadius ?? '20px',
  });
}

export type MessageTone = 'ok' | 'err' | 'warn' | 'info';

export interface MessagePageOptions {
  title: string;
  /** 纯文本，自动转义。 */
  message: string;
  tone?: MessageTone;
  /** 已由调用方转义的补充 HTML。 */
  extraHtml?: string;
  subtitle?: string;
}

/** 结果页/回执页：OAuth、邮箱确认、退订等只有一句话的页面。 */
export function renderMessagePage(options: MessagePageOptions): string {
  const tone: MessageTone = options.tone ?? 'info';
  const body = `<section class="p-card">
    <div class="p-banner ${tone}" role="status">${escapeHtml(options.message)}</div>
    ${options.extraHtml ?? ''}
  </section>`;
  return renderAppPage({
    title: options.title,
    body,
    subtitle: options.subtitle,
  });
}
