import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND, BRAND_FAVICON, BRAND_ICON_SVG } from '../src/brand';

/** 去掉元信息与渐变定义，只留图形本身，便于逐字比较两份副本。 */
function geometry(svg: string): string {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title[\s\S]*?<\/title>/g, '')
    .replace(/<desc[\s\S]*?<\/desc>/g, '')
    .replace(/<defs>[\s\S]*?<\/defs>/g, '')
    .replace(/<svg\b[^>]*>/, '')
    .replace(/<\/svg>/g, '')
    .replace(/url\(#[^)]+\)/g, 'url(#GRAD)')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('品牌色板', () => {
  it('品牌主色是电光蓝；增长绿只作为数据语义色保留', () => {
    expect(BRAND.colors.accent).toBe('#2563EB');
    expect(BRAND.colors.header).toBe('#0B1220');
    // 链接与主色统一，避免两套蓝
    expect(BRAND.colors.link).toBe(BRAND.colors.accent);
    // 「+N 今日 / 新上榜」仍是 GitHub 的增长绿
    expect(BRAND.colors.growth).toBe('#1a7f37');
    expect(BRAND.colors.growthBg).toBe('#dafbe1');
  });
});

describe('BRAND_ICON_SVG', () => {
  it('使用蓝青渐变，不再残留旧的品牌绿', () => {
    expect(BRAND_ICON_SVG).toContain('#3B82F6');
    expect(BRAND_ICON_SVG).toContain('#22D3EE');
    expect(BRAND_ICON_SVG).not.toContain('#1a7f37');
    expect(BRAND_ICON_SVG).not.toContain('#2ea043');
  });

  it('保持内联约束：无外链、无位图、带 data-brand 标记', () => {
    expect(BRAND_ICON_SVG).toContain('data-brand="logo"');
    // 只有 xmlns 命名空间是 http URL（建立 favicon 的 data URI 时需要），不引用任何外部资源
    expect(BRAND_ICON_SVG.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(
      /https?:/,
    );
    expect(BRAND_ICON_SVG).not.toContain('<image');
    expect(BRAND_ICON_SVG).toContain('viewBox="0 0 512 512"');
  });

  it('favicon 是同一图形的 data URI', () => {
    expect(BRAND_FAVICON.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('与 docs/assets/icon.svg 的造型逐字一致（防止运行时图标和仓库源图走样）', () => {
    const source = readFileSync('docs/assets/icon.svg', 'utf8');
    expect(geometry(BRAND_ICON_SVG)).toBe(geometry(source));
  });
});

/** 取出「歪头」那一组几何（图标本体），两边共用的部分。 */
function iconCore(svg: string): string {
  const match = svg.match(/<g transform="rotate\(-5 256 268\)">([\s\S]*?)<\/g>/);
  if (!match) throw new Error('找不到 rotate(-5 256 268) 图标组');
  return match[1]
    .replace(/url\(#[^)]+\)/g, 'url(#GRAD)')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('横版字标 docs/assets/logo-lockup.svg', () => {
  const lockup = readFileSync('docs/assets/logo-lockup.svg', 'utf8');

  it('图标本体与 BRAND_ICON_SVG 同源（改一处必须同步另一处）', () => {
    expect(iconCore(lockup)).toBe(iconCore(BRAND_ICON_SVG));
  });

  it('沿用品牌色，且没有外链或位图', () => {
    expect(lockup).toContain('#3B82F6');
    expect(lockup).toContain('#2563EB');
    expect(lockup).toContain('#0B1220');
    expect(lockup).not.toContain('<image');
    expect(lockup.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:/);
  });

  it('字标是企业名，且不再承诺任何发送时间', () => {
    expect(lockup).toContain('Farsight');
    // 推送时间可配（邮件还分批发），写死时间会跟着代码默认值漂移，所以整份文件（含注释）都不许出现
    expect(lockup).not.toMatch(/09:00|每天/);
  });
});
