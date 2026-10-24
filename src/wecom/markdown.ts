/**
 * 企微 markdown 消息的渲染工具。
 * - 企微 markdown 支持 `[文字](url)` 链接；特殊字符会破坏渲染或被注入伪造链接，
 *   展示文本（含 LLM 生成的简介）一律经 escapeMarkdown 转义。
 * - 仓库名来自抓取数据（GitHub 命名只允许字母数字 - _ .），URL 段原样拼接。
 */

/** 会破坏企微 markdown 渲染/可被用于格式注入的字符。 */
const MARKDOWN_SPECIALS = /[\\*_\[\]()#`]/g;

/** 转义 markdown 特殊字符：反斜杠、星号、下划线、方括号、圆括号、井号、反引号。 */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, (ch) => `\\${ch}`);
}

/** `owner/repo` → `[owner/repo](https://github.com/owner/repo)`（链接文字同样转义）。 */
export function repoLink(fullName: string): string {
  return `[${escapeMarkdown(fullName)}](https://github.com/${fullName})`;
}

/** 单行格式化的最小字段集（搜索结果与每日简报共用）。 */
export interface DisplayEntry {
  fullName: string;
  stars: number;
  starsDelta: number;
  isNew: boolean;
}

/**
 * 单条一行：`1. [owner/repo](url) ★1234 (+567)（新上榜） — 中文简介`。
 * 无简介（缺失/空白）时省略破折号后段；简介经转义后拼接。
 */
export function formatEntryLine(
  index: number,
  entry: DisplayEntry,
  summary?: string,
): string {
  let line = `${index}. ${repoLink(entry.fullName)} ★${entry.stars} (+${entry.starsDelta})`;
  if (entry.isNew) {
    line += '（新上榜）';
  }
  const zh = summary?.trim();
  if (zh) {
    line += ` — ${escapeMarkdown(zh)}`;
  }
  return line;
}
