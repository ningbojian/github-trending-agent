import { BRAND } from '../brand.js';

/**
 * 全站视觉 token：唯一来源是 BRAND，页面里不再写第二份十六进制色值。
 *
 * 这里只做「品牌色 → CSS 变量」的映射，不做设计判断；
 * 圆角与触控高度单独放 UI，方便样式表和测试引用。
 *
 * 网页统一用深色玻璃主题（BRAND.dark）；邮件模板仍是浅色。
 */

export const UI = {
  radius: { shell: 20, card: 14, control: 10 },
  /** 主要动作/导航的最小触控高度（移动端可点性）。 */
  touch: 44,
} as const;

/** 页面底色：深墨夜景 + 右上青光、左下蓝光，与面板同一套。 */
export const APP_PAGE_BG = `radial-gradient(900px 520px at 86% -8%, ${BRAND.dark.glowCyan}, transparent 62%), radial-gradient(760px 520px at 8% 108%, ${BRAND.dark.glowBlue}, transparent 65%), ${BRAND.dark.pageBg}`;

/** 页壳底色：半透明深墨，叠在页面光源上。 */
export const APP_CARD_BG = BRAND.dark.cardBg;

/** 页壳边框：白色半透明。 */
export const APP_CARD_BORDER = BRAND.dark.cardBorder;

/** 页面正文颜色（深底上的近白）。 */
export const APP_TEXT = BRAND.dark.text;

/** 页脚颜色。 */
export const APP_FOOTER = BRAND.dark.faint;

/** CSS 变量块；所有页面的样式表都从这一处取色。 */
export function cssVars(): string {
  const d = BRAND.dark;
  return `:root{
  color-scheme:dark;
  --p-accent:${d.accent};
  --p-accent-soft:${d.accentSoft};
  --p-accent-ink:${d.accentInk};
  --p-text:${d.text};
  --p-muted:${d.muted};
  --p-line:${d.line};
  --p-field-line:${d.fieldLine};
  --p-placeholder:${d.placeholder};
  --p-soft:${d.soft};
  --p-card:${d.card};
  --p-ok:${d.ok};
  --p-ok-bg:${d.okBg};
  --p-danger:${d.danger};
  --p-danger-bg:${d.dangerBg};
  --p-warn:${d.warn};
  --p-warn-bg:${d.warnBg};
  --p-divider:${d.divider};
  --p-radius:${UI.radius.card}px;
}`;
}
