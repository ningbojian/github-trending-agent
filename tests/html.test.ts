import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/http/html';

describe('renderPage — 品牌头', () => {
  it('inlines the brand icon instead of requesting an external image', () => {
    const html = renderPage({ title: '订阅 GitHub 热榜简报', body: '<p>x</p>' });

    expect(html).toContain('data-brand="logo"');
    expect(html).toContain('GitHub 热榜');
    // 邮件客户端/离线打开都不该有外链图片：图标与 favicon 都内联。
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
  });

  it('sets a favicon so the browser tab carries the brand mark', () => {
    const html = renderPage({ title: 'x', body: '' });

    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
  });

  it('sets theme-color and safe-area padding for mobile browsers', () => {
    const html = renderPage({ title: 'x', body: '' });

    expect(html).toContain(`<meta name="theme-color" content="#0B1220">`);
    expect(html).toContain('env(safe-area-inset-bottom)');
  });

  it('renders one small brand header on every page', () => {
    const html = renderPage({ title: 'x', body: '' });

    // 全站一档：28px 图标、17px 标题、12px 内边距。
    expect(html).toContain('width:28px;height:28px;flex:0 0 28px');
    expect(html).toContain('padding:12px 16px');
    expect(html).toContain('font-size:17px;font-weight:700');
    // 旧的大号头（40px 图标）不该再出现。
    expect(html).not.toContain('width:40px;height:40px;flex:0 0 40px');
  });

  it('keeps every dynamic text escaped', () => {
    const html = renderPage({
      title: '<script>alert(1)</script>',
      body: '<p>ok</p>',
      subtitle: '"q"',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;q&quot;');
  });

  it('injects a stylesheet only when styles are provided', () => {
    const plain = renderPage({ title: 'x', body: '' });
    expect(plain).not.toContain('<style>');

    const styled = renderPage({
      title: 'x',
      body: '',
      styles: '.panel-btn{display:inline-block}',
    });
    expect(styled).toContain('<style>.panel-btn{display:inline-block}</style>');
  });

  it('lets callers theme the page shell without affecting other pages', () => {
    const html = renderPage({
      title: 'x',
      body: '',
      pageBg: '#000000',
      cardBg: '#111111',
      cardBorder: '#222222',
      shellClass: 'custom-shell',
      shellRadius: '20px',
    });

    expect(html).toContain('background:#000000');
    expect(html).toContain('background:#111111');
    expect(html).toContain('border:1px solid #222222');
    expect(html).toContain('class="custom-shell"');
    expect(html).toContain('border-radius:20px');
  });
});
