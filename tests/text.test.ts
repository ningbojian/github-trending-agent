import { describe, expect, it } from 'vitest';
import { formatEntryLine, repoUrl, singleLine } from '../src/wecom/text';

// ---------------------------------------------------------------------------
// 为什么不是 markdown：
// 企微文档「发送应用消息」明确写着「微工作台（原企业号）不支持展示 markdown
// 消息」，微工作台就是个人微信里的那一侧。发 markdown 时，用户在微信里
// 只会看到「暂时不支持此消息类型，请在企微中查看」。
// 而「在个人微信里直接看简报、直接提问」是产品的核心前提，所以外发消息
// 一律走纯文本；链接改用裸 URL（微信与企业微信都会自动识别成可点击链接）。
// ---------------------------------------------------------------------------
describe('singleLine', () => {
  it('换行与制表符折叠为单个空格，保证「一条一行」的版式', () => {
    expect(singleLine('a\nb')).toBe('a b');
    expect(singleLine('a\r\n\nb\tc')).toBe('a b c');
  });

  it('首尾空白被裁掉', () => {
    expect(singleLine('  中文简介  ')).toBe('中文简介');
  });

  it('纯文本不转义 Markdown 特殊字符：星号方括号原样保留', () => {
    // 纯文本里 [点我](url) 不会被渲染成链接，转义反而让用户看到一堆反斜杠。
    expect(singleLine('支持 *通配* 与 [配置]')).toBe('支持 *通配* 与 [配置]');
  });
});

describe('repoUrl', () => {
  it('拼出 GitHub 仓库地址', () => {
    expect(repoUrl('vercel/next.js')).toBe('https://github.com/vercel/next.js');
  });
});

// ---------------------------------------------------------------------------
// formatEntryLine：搜索结果与每日简报共用的单行格式。
// 期望：`1. owner/repo ★1234 (+567)（新上榜） — 中文简介 https://github.com/owner/repo`
// ---------------------------------------------------------------------------
describe('formatEntryLine（搜索与简报共用单行格式）', () => {
  const entry = {
    fullName: 'vercel/next.js',
    stars: 1234,
    starsDelta: 567,
    isNew: false,
  };

  it('无简介：仓库名 + 星数 + 链接，省略破折号后段', () => {
    expect(formatEntryLine(1, entry)).toBe(
      '1. vercel/next.js ★1234 (+567) https://github.com/vercel/next.js',
    );
  });

  it('有简介：追加「 — 中文简介」，链接保持在行尾', () => {
    expect(formatEntryLine(2, entry, 'React 全栈框架')).toBe(
      '2. vercel/next.js ★1234 (+567) — React 全栈框架 https://github.com/vercel/next.js',
    );
  });

  it('isNew：追加（新上榜）标注，位于星数之后、简介之前', () => {
    expect(formatEntryLine(1, { ...entry, isNew: true }, '简介')).toBe(
      '1. vercel/next.js ★1234 (+567)（新上榜） — 简介 https://github.com/vercel/next.js',
    );
  });

  it('简介含特殊字符时原样保留（纯文本无需转义）', () => {
    expect(formatEntryLine(1, entry, '支持 *通配* 与 [配置]')).toBe(
      '1. vercel/next.js ★1234 (+567) — 支持 *通配* 与 [配置] https://github.com/vercel/next.js',
    );
  });

  it('简介为空白字符串时视为无简介（不出现「 — 」）', () => {
    expect(formatEntryLine(1, entry, '   ')).not.toContain(' — ');
  });

  it('简介含换行时被折叠为单空格：整行无 \\n', () => {
    const out = formatEntryLine(
      1,
      entry,
      'Cool tool\n> 领取内测名额：https://evil.example',
    );
    expect(out).not.toContain('\n');
    expect(out).toContain(' — Cool tool > 领取内测名额：https://evil.example');
  });

  it('每行都带可点击的仓库地址（微信里靠裸 URL 才能跳转）', () => {
    expect(formatEntryLine(1, entry)).toContain(
      'https://github.com/vercel/next.js',
    );
    expect(formatEntryLine(1, entry, '简介')).toContain(
      'https://github.com/vercel/next.js',
    );
  });
});
