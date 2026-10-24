import { describe, expect, it } from 'vitest';
import {
  escapeMarkdown,
  formatEntryLine,
  repoLink,
} from '../src/wecom/markdown';

// ---------------------------------------------------------------------------
// escapeMarkdown：企微 markdown 消息里特殊字符会破坏渲染/注入格式，统一加反斜杠。
// ---------------------------------------------------------------------------
describe('escapeMarkdown', () => {
  it('转义 \\ * _ [ ] ( ) # 与反引号，每个特殊字符前加一个反斜杠', () => {
    expect(escapeMarkdown('a\\b*c_d[e](f)#g`h')).toBe(
      'a\\\\b\\*c\\_d\\[e\\]\\(f\\)\\#g\\`h',
    );
  });

  it('markdown 注入防护：伪造的链接语法被转义成纯文本', () => {
    // 攻击面：LLM 生成的简介里混入 [点我](恶意url) 会变成可点链接
    expect(escapeMarkdown('[点我](https://evil.example.com)')).toBe(
      '\\[点我\\]\\(https://evil.example.com\\)',
    );
  });

  it('普通中英文文本逐字符不变（无特殊字符时零开销）', () => {
    expect(escapeMarkdown('Python AI 框架与工具链')).toBe('Python AI 框架与工具链');
  });

  it('反斜杠最先转义，避免后续转义结果被二次解读', () => {
    expect(escapeMarkdown('\\*')).toBe('\\\\\\*');
  });
});

// ---------------------------------------------------------------------------
// repoLink：`[owner/repo](https://github.com/owner/repo)`，链接文字同样转义。
// ---------------------------------------------------------------------------
describe('repoLink', () => {
  it('普通仓库名 → GitHub 链接，文字不转义（无特殊字符）', () => {
    expect(repoLink('vercel/next.js')).toBe(
      '[vercel/next.js](https://github.com/vercel/next.js)',
    );
  });

  it('仓库名含 markdown 特殊字符时，链接文字被转义、URL 保持原样', () => {
    expect(repoLink('a[b]/c(d)')).toBe(
      '[a\\[b\\]/c\\(d\\)](https://github.com/a[b]/c(d))',
    );
  });
});

// ---------------------------------------------------------------------------
// formatEntryLine：搜索结果与每日简报共用的单行格式。
// 期望：`1. [owner/repo](url) ★1234 (+567)（新上榜） — 中文简介`
// ---------------------------------------------------------------------------
describe('formatEntryLine（搜索与简报共用单行格式）', () => {
  const entry = {
    fullName: 'vercel/next.js',
    stars: 1234,
    starsDelta: 567,
    isNew: false,
  };

  it('无简介：省略破折号后段', () => {
    expect(formatEntryLine(1, entry)).toBe(
      '1. [vercel/next.js](https://github.com/vercel/next.js) ★1234 (+567)',
    );
  });

  it('有简介：追加「 — 中文简介」', () => {
    expect(formatEntryLine(2, entry, 'React 全栈框架')).toBe(
      '2. [vercel/next.js](https://github.com/vercel/next.js) ★1234 (+567) — React 全栈框架',
    );
  });

  it('isNew：追加（新上榜）标注，位于星数之后、简介之前', () => {
    expect(formatEntryLine(1, { ...entry, isNew: true }, '简介')).toBe(
      '1. [vercel/next.js](https://github.com/vercel/next.js) ★1234 (+567)（新上榜） — 简介',
    );
  });

  it('简介含特殊字符时被转义，防止破坏消息渲染', () => {
    expect(formatEntryLine(1, entry, '支持 *通配* 与 [配置]')).toBe(
      '1. [vercel/next.js](https://github.com/vercel/next.js) ★1234 (+567) — 支持 \\*通配\\* 与 \\[配置\\]',
    );
  });

  it('简介为空白字符串时视为无简介（不出现「 — 」）', () => {
    expect(formatEntryLine(1, entry, '   ')).not.toContain(' — ');
  });
});
