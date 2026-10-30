import { describe, expect, it } from 'vitest';
import type { DigestSnapshotItem } from '../src/agent/digest-snapshot';
import { BRAND } from '../src/brand';
import { emailSubject, renderConfirmEmail, renderDigestEmail, renderManageEmail } from '../src/email/render';

function item(overrides: Partial<DigestSnapshotItem> = {}): DigestSnapshotItem {
  return {
    fullName: 'owner/repo',
    description: 'A repo',
    topics: ['cli'],
    language: 'typescript',
    stars: 12345,
    starsDelta: 567,
    isNew: false,
    htmlUrl: 'https://github.com/owner/repo',
    ...overrides,
  };
}

const BASE = {
  date: '2026-10-25',
  pushTime: '09:00',
  abstract: '今天的榜单集中在 AI 工具与开发效率上。',
  items: [item()],
  baseUrl: 'https://agent.example.com',
  unsubToken: 'tok en/1',
};

describe('emailSubject', () => {
  it('uses the fixed `品牌简报 · MM-DD` format', () => {
    expect(emailSubject('2026-10-25')).toBe('GitHub 热榜简报 · 10-25');
    expect(emailSubject('2026-01-02')).toBe('GitHub 热榜简报 · 01-02');
  });

  it('falls back to the raw date when the shape is unexpected', () => {
    expect(emailSubject('2026-10')).toBe('GitHub 热榜简报 · 2026-10');
  });
});

describe('renderDigestEmail — HTML', () => {
  it('carries the brand header, date and Beijing push time', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).toContain(BRAND.name);
    expect(html).toContain('2026-10-25');
    expect(html).toContain('北京时间 09:00');
    expect(html).toContain(`background:${BRAND.colors.header}`);
  });

  it('is mobile-first: viewport meta and table layout', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain('<table role="presentation"');
  });

  it('shows the greeting, abstract block and preheader', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).toContain('你好，这是今天的 GitHub 热榜简报。');
    expect(html).toContain(BASE.abstract);
    expect(html).toContain('今日 1 个热榜项目：owner/repo');
  });

  it('omits the abstract block when the snapshot has no abstract', () => {
    const { html, text } = renderDigestEmail({ ...BASE, abstract: null });
    expect(html).not.toContain(BASE.abstract);
    expect(html).toContain('你好，这是今天的 GitHub 热榜简报。');
    // 纯文本同样不留空行占位（问候之后直接是首条）。
    expect(text).not.toContain(BASE.abstract);
  });

  it('renders rank, linked repo name, star/delta/new badges and summary', () => {
    const { html } = renderDigestEmail({
      ...BASE,
      items: [
        item({ isNew: true, summary: '一个命令行工具。' }),
        item({
          fullName: 'second/repo',
          htmlUrl: 'https://github.com/second/repo',
          stars: 999,
          starsDelta: 0,
        }),
      ],
    });
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('href="https://github.com/owner/repo"');
    expect(html).toContain('★ 12,345');
    expect(html).toContain('+567 今日');
    expect(html).toContain('新上榜');
    expect(html).toContain('一个命令行工具。');
    // starsDelta = 0 → 不显示「+0 今日」胶囊。
    expect(html).not.toContain('+0 今日');
  });

  it('escapes every dynamic text（仓库名 / 简介 / 概览）', () => {
    const { html } = renderDigestEmail({
      ...BASE,
      abstract: '<script>alert(1)</script>',
      items: [
        item({
          fullName: 'evil/<b>repo</b>',
          htmlUrl: 'https://github.com/evil/x?a=1&b="2"',
          summary: '带 <img src=x onerror=alert(1)> 的简介',
        }),
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<b>repo</b>');
    expect(html).toContain('evil/&lt;b&gt;repo&lt;/b&gt;');
    expect(html).not.toContain('<img src=x');
    // href 属性里的引号与 & 一并转义。
    expect(html).toContain('href="https://github.com/evil/x?a=1&amp;b=&quot;2&quot;"');
  });

  it('links settings and unsubscribe with the encoded unsubToken', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).toContain(
      'href="https://agent.example.com/api/email-settings?t=tok%20en%2F1"',
    );
    expect(html).toContain(
      'href="https://agent.example.com/api/email-unsubscribe?t=tok%20en%2F1"',
    );
  });

  it('tolerates a baseUrl with trailing slashes', () => {
    const { html } = renderDigestEmail({
      ...BASE,
      baseUrl: 'https://agent.example.com///',
    });
    expect(html).toContain(
      'href="https://agent.example.com/api/email-unsubscribe?t=tok%20en%2F1"',
    );
  });

  it('does not truncate: all 20 items are present', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item({
        fullName: `owner/repo-${index + 1}`,
        htmlUrl: `https://github.com/owner/repo-${index + 1}`,
        stars: 1000 + index,
        starsDelta: index,
        summary: `第 ${index + 1} 个项目的中文简介。`,
      }),
    );
    const { html, text } = renderDigestEmail({ ...BASE, items });
    expect(html).toContain('#20');
    expect(html).toContain('owner/repo-20');
    expect(html).toContain('第 20 个项目的中文简介。');
    expect(html).not.toContain('已截断');
    expect(text).toContain('20. owner/repo-20');
  });

  it('contains no external images or tracking pixels', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('width="1" height="1"');
  });
});

describe('renderDigestEmail — plain text', () => {
  it('includes greeting, meta line, full URL and summary', () => {
    const { text } = renderDigestEmail({
      ...BASE,
      items: [item({ summary: '一个命令行工具。' })],
    });
    expect(text).toContain('你好，这是今天的 GitHub 热榜简报（2026-10-25）。');
    expect(text).toContain(BASE.abstract);
    expect(text).toContain('1. owner/repo（★ 12,345 / +567 今日）');
    expect(text).toContain('https://github.com/owner/repo');
    expect(text).toContain('一个命令行工具。');
    expect(text).toContain(
      '调整推送时间 / 频率：https://agent.example.com/api/email-settings?t=tok%20en%2F1',
    );
    expect(text).toContain(
      '退订：https://agent.example.com/api/email-unsubscribe?t=tok%20en%2F1',
    );
  });

  it('marks new entries and falls back to a github.com URL', () => {
    const { text } = renderDigestEmail({
      ...BASE,
      items: [item({ isNew: true, htmlUrl: '' })],
    });
    expect(text).toContain('新上榜');
    expect(text).toContain('https://github.com/owner/repo');
  });

  it('renders an empty day without crashing', () => {
    const { html, text } = renderDigestEmail({ ...BASE, items: [] });
    expect(html).toContain('今日暂无热榜项目');
    expect(text).toContain('你好，这是今天的 GitHub 热榜简报（2026-10-25）。');
    // 序号单元格形如「>#1<」；不能直接断言 '#1'，品牌色 #1f2328 里也含该子串。
    expect(html).not.toContain('>#1<');
  });
});

describe('确认信 / 管理信', () => {
  it('确认信使用 table 布局，不带 style 标签和外链图片', () => {
    const html = renderConfirmEmail({
      subject: '确认订阅 GitHub 热榜简报',
      lead: '你好，点击下面的按钮确认订阅 GitHub 热榜简报。',
      confirmUrl: 'https://agent.example.com/api/email-confirm?t=a%2Fb',
      actionLabel: '确认订阅',
    });

    expect(html).toContain('<table role="presentation"');
    expect(html).not.toContain('<style');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('https://agent.example.com/api/email-confirm?t=a%2Fb');
    expect(html).toContain('48 小时');
  });

  it('管理信包含设置与退订链接，并转义 & 符号', () => {
    const html = renderManageEmail({
      settingsUrl: 'https://agent.example.com/api/email-settings?t=a&b',
      unsubscribeUrl: 'https://agent.example.com/api/email-unsubscribe?t=a&b',
    });

    expect(html).toContain('role="presentation"');
    expect(html).toContain('调整推送时间 / 频率');
    expect(html).toContain('退订');
    expect(html).toContain('t=a&amp;b');
  });
});
