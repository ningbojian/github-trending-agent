/**
 * 外发消息的纯文本渲染工具。
 *
 * 为什么是纯文本而不是 markdown：企微文档「发送应用消息」写明
 * 「微工作台（原企业号）不支持展示 markdown 消息」——微工作台就是个人微信
 * 里的那一侧。发 markdown 时用户只会看到「暂时不支持此消息类型，请在企微中查看」，
 * 而「直接在微信里看简报、直接提问」是本产品的核心前提。
 * 链接改为行尾的裸 URL：微信与企业微信都会把它自动识别成可点击链接。
 *
 * - 展示文本（含 LLM 生成的简介）一律经 singleLine 折叠换行，保证「一条一行」。
 * - 仓库名来自抓取数据（GitHub 命名只允许字母数字 - _ .），URL 段原样拼接。
 */

/** 换行与制表符：连续折叠为单个空格，保证展示文本恒为单行（不会破坏列表版式）。 */
const WHITESPACE_RUN = /[\r\n\t]+/g;

/**
 * 把任意展示文本压成单行：折叠 CR/LF/制表符并去掉首尾空白。
 * description（fallbackZh 截断）与 LLM 生成的简介都可能带换行，
 * 原样进入单行列表会破坏排版，因此在渲染边界统一收口。
 */
export function singleLine(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim();
}

/** `owner/repo` → `https://github.com/owner/repo`。 */
export function repoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

/** 单行格式化的最小字段集（搜索结果与每日简报共用）。 */
export interface DisplayEntry {
  fullName: string;
  stars: number;
  starsDelta: number;
  isNew: boolean;
}

/**
 * 单条一行：`1. owner/repo ★1234 (+567)（新上榜） — 中文简介 https://github.com/owner/repo`。
 * 无简介（缺失/空白）时省略破折号后段；链接始终在行尾，方便直接点开。
 */
export function formatEntryLine(
  index: number,
  entry: DisplayEntry,
  summary?: string,
): string {
  let line = `${index}. ${singleLine(entry.fullName)} ★${entry.stars} (+${entry.starsDelta})`;
  if (entry.isNew) {
    line += '（新上榜）';
  }
  const zh = summary?.trim();
  if (zh) {
    line += ` — ${singleLine(zh)}`;
  }
  return `${line} ${repoUrl(entry.fullName)}`;
}
