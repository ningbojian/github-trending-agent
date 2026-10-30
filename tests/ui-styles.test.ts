import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../src/brand';
import { PANEL_STYLES } from '../src/panel/styles';
import { BASE_STYLES } from '../src/ui/styles';

/**
 * 共享样式层的硬约束。不锁完整 CSS，只钉住会影响可用性和品牌一致性的点。
 */
describe('BASE_STYLES', () => {
  it('takes every color from BRAND.dark, not a second palette', () => {
    expect(BASE_STYLES).toContain(`--p-accent:${BRAND.dark.accent}`);
    expect(BASE_STYLES).toContain(`--p-text:${BRAND.dark.text}`);
    expect(BASE_STYLES).toContain(`--p-muted:${BRAND.dark.muted}`);
    expect(BASE_STYLES).toContain(`--p-line:${BRAND.dark.line}`);
    expect(BASE_STYLES).toContain(`--p-ok:${BRAND.dark.ok}`);
    expect(BASE_STYLES).toContain(`--p-danger:${BRAND.dark.danger}`);
    // 浅色主题已经下线：白底、深色正文不该再出现在共享层。
    expect(BASE_STYLES).not.toContain(BRAND.colors.pageBg);
    expect(BASE_STYLES).not.toContain(`--p-text:${BRAND.colors.text}`);
  });

  it('keeps primary actions at 44px and the panel nav compact', () => {
    expect(BASE_STYLES).toMatch(/\.p-btn\{[^}]*min-height:44px/);
    expect(PANEL_STYLES).toMatch(/\.panel-nav a\{[^}]*min-height:38px/);
    expect(BASE_STYLES).toMatch(/\.p-input,[^{]*\{[^}]*min-height:44px/);
  });

  it('scales the brand icon into its container on every page', () => {
    expect(BASE_STYLES).toMatch(/\.p-header-icon svg\{[^}]*width:100%;height:100%/);
    // 尺寸已全站统一，面板不再单独覆盖品牌头。
    expect(PANEL_STYLES).not.toContain('.panel-header .p-header-icon');
  });

  it('measures heights with border-box, so min-height is the real height', () => {
    // 内容盒下 min-height:44px 还要再加 10px padding 与边框，按钮会虚高到 66px。
    expect(BASE_STYLES).toContain('*,*::before,*::after{box-sizing:border-box;}');
  });

  it('gives form controls a visible boundary and readable placeholder', () => {
    expect(BASE_STYLES).toContain(`--p-field-line:${BRAND.dark.fieldLine}`);
    expect(BASE_STYLES).toContain(`--p-placeholder:${BRAND.dark.placeholder}`);
    expect(BASE_STYLES).toContain('border:1px solid var(--p-field-line)');
    expect(BASE_STYLES).toContain('.p-input::placeholder{color:var(--p-placeholder);}');
  });

  it('draws a solid focus ring instead of a 35% wash', () => {
    expect(BASE_STYLES).toContain('outline:3px solid var(--p-accent)');
  });

  it('keeps the panel hero clear of the mascot and drops the trailing gap', () => {
    expect(PANEL_STYLES).toContain('.panel .p-hero-card{padding-right:76px;}');
    expect(PANEL_STYLES).toContain('.panel .p-card:last-child{margin-bottom:0;}');
  });

  it('keeps the two join QR codes side by side on a 390px phone', () => {
    // 132+132+12=276 > 卡片内宽 274，窄屏必须缩到 124 才不会掉成上下两行。
    expect(BASE_STYLES).toContain('.p-qr img{width:124px;height:124px;}');
  });

  it('scrolls tables inside the card instead of the page', () => {
    expect(BASE_STYLES).toMatch(/\.p-table-wrap\{[^}]*overflow-x:auto/);
    expect(BASE_STYLES).toContain('-webkit-overflow-scrolling:touch');
  });

  it('has focus, hover and reduced-motion states', () => {
    expect(BASE_STYLES).toContain(':focus-visible');
    expect(BASE_STYLES).toContain('@media (hover:hover)');
    expect(BASE_STYLES).toContain('@media (prefers-reduced-motion:reduce)');
  });

  it('is the prefix of the panel styles', () => {
    expect(PANEL_STYLES.startsWith(BASE_STYLES)).toBe(true);
  });

  it('does not reintroduce the old palette outside brand.ts', () => {
    const oldHex = ['#57606a', '#dbe3ec', '#d0d7de'];
    const offenders: string[] = [];
    for (const dir of ['api', join('src', 'ui'), join('src', 'panel')]) {
      for (const file of readdirSync(join(process.cwd(), dir))) {
        if (!file.endsWith('.ts')) continue;
        const text = readFileSync(join(process.cwd(), dir, file), 'utf8').toLowerCase();
        for (const hex of oldHex) {
          if (text.includes(hex)) offenders.push(`${dir}/${file}:${hex}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
