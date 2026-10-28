import { displayWidth } from '../text-width.js';

/**
 * 企微 news 卡片的渲染规则（纯函数，无网络/DB）。
 *
 * 为什么单独一层：这些约束来自 2026-10-28 在个人微信里的实测，不是审美偏好——
 * - 一条 news 最多 8 篇，第 9 篇会被企微以 `45008 article size out of limit` 拒绝；
 * - 多篇布局里**只有标题可见**，`description` 不显示；
 * - 标题在客户端约 10–12 个汉字处被裁，尾部内容用户永远看不到；
 * - 第 1 篇是大图 + 标题；第 2 篇起只有标题。**其余条目刻意不发图**：
 *   微信是打开会话时才逐张抓 `picurl`，连静态 CDN 的图也会一张一张慢慢出、
 *   偶尔失败（实测 8 张里 1–3 张长期灰着）。一张 OG 大图既稳定又有视觉锚点，
 *   七张不稳定的缩略图只会显得破。
 *
 * 标题的信息顺序因此是硬要求：仓库名必须在最前（最先可见），
 * 短简介放在尾部（可被裁剪）。
 *
 * 简介不硬截：短简介由模型单独生成（≤18 个汉字，完整短语）；
 * 拿不到就退回「完整分句」，再拿不到就**干脆不写**——绝不出现半句话加省略号。
 */

/** 企微 news 一条消息最多 8 篇（第 9 篇实测被拒：45008）。 */
export const NEWS_MAX_ARTICLES = 8;

/** 只有这批里增量最猛的 1–2 条给 🔥；每条都亮等于每条都不亮。 */
export const HOT_TOP_N = 2;
/** 火苗的绝对下限：增量没到这条线，一个都不给（避免小仓库靠极低基数刷榜）。 */
export const HOT_MIN_DELTA = 100;
/** 火苗的增长率下限：`+增量 / 总星标` ≥ 5%（一周）。基量大小不再决定谁能亮。 */
export const HOT_MIN_RATE = 0.05;

/**
 * 短简介的显示宽度上限（列）：汉字/全角算 2 列，ASCII 算 1 列。
 * 实测行标题在仓库名与星标之后只剩约 20 列。
 */
export const SHORT_SUMMARY_MAX_WIDTH = 40;

/** 企微 news 单篇标题的字节上限。 */
const TITLE_MAX_BYTES = 128;

/** 进入标题的最小字段集。 */
export interface NewsEntry {
  fullName: string;
  stars: number;
  starsDelta: number;
  isNew: boolean;
  language: string | null;
  /** 完整中文简介（多篇布局不显示，仍随卡片发送）。 */
  summary?: string;
  /** 模型生成的完整短句（≤18 个汉字）；缺省时退回完整分句。 */
  short?: string;
}

export interface NewsArticle {
  title: string;
  description?: string;
  url: string;
  /** 只有第 1 篇带图（GitHub OG）；其余条目不发图。 */
  picurl?: string;
}

export interface BuildNewsOptions {
  /** 仓库主页；缺省用 GitHub URL。 */
  htmlUrlOf?: (entry: NewsEntry) => string | undefined;
}

/** 43800 → 43.8k；158300 → 158k；999 → 999。标题空间有限，不写全量数字。 */
export function shortStars(stars: number): string {
  if (!Number.isFinite(stars) || stars < 1000) return String(Math.trunc(stars));
  const k = stars / 1000;
  return k < 100 ? `${Number.isInteger(k) ? k : k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** 去掉首尾空白与结尾标点/省略号：短句不该以「，」「…」收尾。 */
function cleanShort(text: string): string {
  return text
    .trim()
    .replace(/^[「『“"'（(]+/, '')
    .replace(/[，。；：、,.;:!?！？…「」『』“”"'）)]+$/u, '')
    .trim();
}

/** 完整分句：取第一个标点之前的部分；超过显示宽度就放弃（宁可没有，也不截半句）。 */
export function deriveShort(summary: string | undefined): string {
  const text = (summary ?? '').trim();
  if (text === '') return '';
  const clause = text.split(/[，。；：、,.;:!?！？]/u)[0] ?? '';
  const candidate = cleanShort(clause);
  if (candidate === '') return '';
  return displayWidth(candidate) <= SHORT_SUMMARY_MAX_WIDTH ? candidate : '';
}

/** 模型给的短句：清洗后仍超宽就放弃——不把长句硬切进标题。 */
function normalizeShort(short: string | undefined): string {
  const text = cleanShort(short ?? '');
  if (text === '') return '';
  return displayWidth(text) <= SHORT_SUMMARY_MAX_WIDTH ? text : '';
}

/** 按码点截断到不超过 maxBytes，保留结尾省略号的位置。 */
function clipToBytes(text: string, maxBytes: number): string {
  const chars = Array.from(text);
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let used = 0;
  let keep = 0;
  for (const char of chars) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > budget) break;
    used += size;
    keep += 1;
  }
  return `${chars.slice(0, keep).join('').trimEnd()}${ellipsis}`;
}

/** 标题头：标记 + 序号 + 仓库 + 星标（一定可见的部分）。 */
function titleHead(index: number, entry: NewsEntry, hot: boolean): string {
  const marker = hot ? '🔥 ' : entry.isNew ? '🆕 ' : '';
  return `${marker}${index + 1}. ${entry.fullName} ★${shortStars(entry.stars)} (+${entry.starsDelta})`;
}

/**
 * 组装标题：固定头 + `｜短简介`。
 * 头本身超限（极长仓库名）时硬截；加上简介会超限时**整段简介放弃**，
 * 不把短句切一半——用户已经明确说过半句话比没有更糟。
 */
function buildTitle(index: number, entry: NewsEntry, hot: boolean): string {
  const head = titleHead(index, entry, hot);
  if (Buffer.byteLength(head, 'utf8') > TITLE_MAX_BYTES) {
    return clipToBytes(head, TITLE_MAX_BYTES);
  }

  const short = normalizeShort(entry.short) || deriveShort(entry.summary);
  if (short === '') return head;

  const full = `${head}｜${short}`;
  return Buffer.byteLength(full, 'utf8') <= TITLE_MAX_BYTES ? full : head;
}

function ogUrl(fullName: string): string {
  return `https://opengraph.githubassets.com/1/${fullName}`;
}

/** 一周增长率：新增星标 / 总星标。绝对增量会永远锁死在榜首，增长率不会。 */
function growthRate(entry: NewsEntry): number {
  return entry.stars > 0 ? entry.starsDelta / entry.stars : 0;
}

/** 增长率过线、且增量不低于绝对下限的条目里，取增长最快的 1–2 条。 */
function hotIndexes(entries: NewsEntry[]): Set<number> {
  const ranked = entries
    .map((entry, index) => ({ entry, index, rate: growthRate(entry) }))
    .filter(
      (item) => item.entry.starsDelta >= HOT_MIN_DELTA && item.rate >= HOT_MIN_RATE,
    )
    .sort((a, b) => b.rate - a.rate)
    .slice(0, HOT_TOP_N);
  return new Set(ranked.map((item) => item.index));
}

/**
 * 把条目渲染成 news 文章列表：
 * - 第 1 篇用 OG 海报（多篇布局里唯一的大图）；
 * - 第 2 篇起用我们域名下的 `/api/tile`（头像 → 失败回退语言色块）；
 * - 超过 8 条截断——企微硬上限，多一条整条消息都会被拒。
 */
export function buildNewsArticles(
  entries: NewsEntry[],
  options: BuildNewsOptions = {},
): NewsArticle[] {
  const limited = entries.slice(0, NEWS_MAX_ARTICLES);
  const hot = hotIndexes(limited);
  return limited.map((entry, index) => {
    const htmlUrl = options.htmlUrlOf?.(entry)?.trim();
    return {
      title: buildTitle(index, entry, hot.has(index)),
      // 多篇布局不显示 description；保留完整简介，客户端若显示则更有信息量。
      ...(entry.summary?.trim() ? { description: entry.summary.trim() } : {}),
      url: htmlUrl !== undefined && htmlUrl !== '' ? htmlUrl : `https://github.com/${entry.fullName}`,
      // 只有第 1 篇带图：多张图会被微信逐张慢慢抓，反而更慢、更破。
      ...(index === 0 ? { picurl: ogUrl(entry.fullName) } : {}),
    };
  });
}
