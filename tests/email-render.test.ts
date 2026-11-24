import { describe, expect, it } from 'vitest';
import type { DigestSnapshotItem } from '../src/agent/digest-snapshot';
import { BRAND } from '../src/brand';
import { emailSubject, renderConfirmEmail, renderDigestEmail, renderManageEmail } from '../src/email/render';
import type { OpportunityItem } from '../src/opportunities/types';

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
    expect(html).toContain('background:#141922');
  });

  it('uses the dark skin with an explicit color-scheme declaration', () => {
    const { html } = renderDigestEmail(BASE);
    // 深色底 + 实色卡片；声明 dark 让客户端别自作主张反色。
    expect(html).toContain('name="color-scheme" content="dark light"');
    expect(html).toContain('bgcolor="#141922"');
    expect(html).toContain('background:#1B222C');
    expect(html).toContain(`color:${BRAND.dark.accent}`);
  });

  it('is mobile-first: viewport meta and table layout', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain('<table role="presentation"');
  });

  it('shows the compact intro, abstract block and preheader', () => {
    const { html } = renderDigestEmail(BASE);
    expect(html).toContain('今天 1 个项目');
    expect(html).toContain(BASE.abstract);
    expect(html).toContain('今天 1 个项目：owner/repo');
  });

  it('explains how many candidates were filtered down', () => {
    const { html, text } = renderDigestEmail({ ...BASE, poolSize: 120 });
    expect(html).toContain('今天 1 个项目（从 120 个候选里筛出）');
    expect(text).toContain('今天 1 个项目（从 120 个候选里筛出）');
  });

  it('uses a compact list without stats strip or growth bars', () => {
    const { html, text } = renderDigestEmail({
      ...BASE,
      poolSize: 100,
      items: [item({ starsDelta: 500 }), item({ fullName: 'b/c', starsDelta: 100 })],
    });
    expect(html).toContain('今天 2 个项目（从 100 个候选里筛出）');
    expect(html).not.toContain('今日候选');
    expect(html).not.toContain('总涨幅');
    expect(html).not.toContain('bgcolor="#22D3EE"');
    expect(html).not.toContain('<img');
    expect(text).not.toContain('总涨幅');
  });

  it('omits the abstract block when the snapshot has no abstract', () => {
    const { html, text } = renderDigestEmail({ ...BASE, abstract: null });
    expect(html).not.toContain(BASE.abstract);
    expect(html).not.toContain('你好，这是今天的 GitHub 热榜简报。');
    // 纯文本同样不留空行占位。
    expect(text).not.toContain(BASE.abstract);
  });

  it('renders compact rank, repo, stars/delta/new and summary', () => {
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
    expect(html).toContain('1.');
    expect(html).toContain('2.');
    expect(html).toContain('href="https://github.com/owner/repo"');
    expect(html).toContain('★ 12,345');
    expect(html).toContain('+567');
    expect(html).toContain(' · 新');
    expect(html).toContain('一个命令行工具。');
    expect(html).not.toContain('+0');
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
    expect(html).toContain('20.');
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
  it('includes intro, meta line, full URL and summary', () => {
    const { text } = renderDigestEmail({
      ...BASE,
      items: [item({ summary: '一个命令行工具。' })],
    });
    expect(text).toContain('今天 1 个项目');
    expect(text).toContain(BASE.abstract);
    expect(text).toContain('1. owner/repo（★ 12,345 · +567）');
    expect(text).toContain('https://github.com/owner/repo');
    expect(text).toContain('一个命令行工具。');
    expect(text).toContain(
      '调整设置：https://agent.example.com/api/email-settings?t=tok%20en%2F1',
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
    expect(text).toContain('· 新');
    expect(text).toContain('https://github.com/owner/repo');
  });

  it('renders an empty day without crashing', () => {
    const { html, text } = renderDigestEmail({ ...BASE, items: [] });
    expect(html).toContain('今日暂无热榜项目');
    expect(text).toContain('今天 0 个项目');
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

describe('邮件里的仓库链接', () => {
  const confirm = renderConfirmEmail({
    subject: '确认订阅 GitHub 热榜简报',
    lead: '你好，点击下面的按钮确认订阅 GitHub 热榜简报。',
    confirmUrl: 'https://agent.example.com/api/email-confirm?t=a%2Fb',
    actionLabel: '确认订阅',
  });
  const manage = renderManageEmail({
    settingsUrl: 'https://agent.example.com/api/email-settings?t=a',
    unsubscribeUrl: 'https://agent.example.com/api/email-unsubscribe?t=a',
  });

  it('确认信、管理信保留图标按钮；简报用文字链接', () => {
    for (const html of [confirm, manage]) {
      expect(html).toContain(`href="${BRAND.repoUrl}"`);
      expect(html).toContain('aria-label="GitHub 仓库"');
      expect(html).toContain('<svg');
      expect(html).not.toContain('GitHub 仓库 ↗');
      expect(html).not.toMatch(/<img/i);
    }
    const digest = renderDigestEmail(BASE).html;
    expect(digest).toContain(`href="${BRAND.repoUrl}"`);
    expect(digest).toContain('>GitHub 仓库</a>');
    expect(digest).not.toContain('aria-label="GitHub 仓库"');
    expect(digest).not.toContain('<svg');
    expect(digest).not.toMatch(/<img/i);
  });

  it('简报纯文本附上仓库地址，方便纯文本客户端', () => {
    const { text } = renderDigestEmail(BASE);
    expect(text).toContain(`GitHub 仓库：${BRAND.repoUrl}`);
  });

  it('确认信按钮与网页共用 GitHub 黑白标色板', () => {
    expect(confirm).toContain(`background:${BRAND.repoButton.background}`);
    expect(confirm).toContain(`border:1px solid ${BRAND.repoButton.border}`);
    expect(confirm).toContain(`fill="${BRAND.repoButton.text}"`);
  });

  it('每天附带的「今日机会」同时出现在 HTML 和纯文本，且在热榜之后', () => {
    const opportunity: OpportunityItem = {
      id: 'contribute:acme/agent#12',
      kind: 'contribute',
      repo: 'acme/agent',
      issueNumber: 12,
      title: 'Windows 下 CUDA 检测失败',
      body: '...',
      url: 'https://github.com/acme/agent/issues/12',
      language: 'typescript',
      topics: ['agent'],
      stars: 500,
      license: 'MIT',
      archived: false,
      pushedAt: '2026-11-10T00:00:00Z',
      labels: ['good first issue'],
      comments: 3,
      reactions: 2,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-16T00:00:00Z',
      maintainerEngaged: true,
      assigned: false,
      linkedPr: false,
      repoSummary: '智能体工具库',
      score: 80,
      why: '值得修。',
      firstStep: '复现并认领。',
      effort: '小',
      confidence: '高',
      evidence: [],
    };
    const rendered = renderDigestEmail({ ...BASE, opportunities: [opportunity] });
    expect(rendered.html).toContain('今日机会');
    expect(rendered.html).not.toContain('本周机会');
    expect(rendered.html).toContain('acme/agent，issue 12');
    expect(rendered.html).not.toContain('填坑：');
    expect(rendered.text).not.toContain('填坑：');
    // 第一行仓库描述，第二行 issue 问题；不再显示第一步。
    expect(rendered.html.indexOf('智能体工具库')).toBeLessThan(
      rendered.html.indexOf('Windows 下 CUDA 检测失败'),
    );
    expect(rendered.text.indexOf('智能体工具库')).toBeLessThan(
      rendered.text.indexOf('Windows 下 CUDA 检测失败'),
    );
    expect(rendered.html).not.toContain('第一步');
    expect(rendered.text).not.toContain('第一步');
    expect(rendered.html).toContain('https://github.com/acme/agent/issues/12');
    expect(rendered.text).toContain('今日机会');
    expect(rendered.text).not.toContain('本周机会');
    expect(rendered.text).toContain('https://github.com/acme/agent/issues/12');
    expect(rendered.html.indexOf('owner/repo')).toBeLessThan(
      rendered.html.indexOf('今日机会'),
    );
    expect(rendered.text.indexOf('owner/repo')).toBeLessThan(
      rendered.text.indexOf('今日机会'),
    );
  });
});
