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
});
