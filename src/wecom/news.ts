/**
 * 企微 news 卡片的渲染规则（纯函数，无网络/DB）。
 *
 * 为什么单独一层：这些约束来自 2026-10-28 在个人微信里的实测，不是审美偏好——
 * - 一条 news 最多 8 篇，第 9 篇会被企微以 `45008 article size out of limit` 拒绝；
 * - 多篇布局里**只有标题可见**，`description` 不显示；
 * - 标题在客户端约 10–12 个汉字处被裁，尾部内容用户永远看不到；
 * - 第 2 篇之后是方形缩略图，第三方图床会被企微随机丢弃（灰头像），
 *   所以图片统一走我们自己的 `/api/tile`。
 *
 * 标题的信息顺序因此是硬要求：仓库名必须在最前（最先可见），
 * 语言标签与压缩简介放在尾部（可被裁剪）。
 */

/** 企微 news 一条消息最多 8 篇（第 9 篇实测被拒：45008）。 */
export const NEWS_MAX_ARTICLES = 8;

/** 新增星标达到该值给 🔥。低于它但 `isNew` 的给 🆕（二选一，省标题空间）。 */
export const HOT_DELTA = 300;

/**
 * 压缩简介的显示宽度上限（列）：汉字/全角算 2 列，ASCII 算 1 列。
 * 实测行标题在仓库名与星标之后只剩约 20 列，超出会被客户端裁掉。
 */
export const SHORT_SUMMARY_MAX_WIDTH = 20;

/** 企微 news 单篇标题的字节上限。 */
const TITLE_MAX_BYTES = 128;

/** 进入标题的最小字段集。 */
export interface NewsEntry {
  fullName: string;
  stars: number;
  starsDelta: number;
  isNew: boolean;
  language: string | null;
  /** 完整中文简介；标题里只用压缩后的前一段。 */
  summary?: string;
}

export interface NewsArticle {
  title: string;
  description?: string;
  url: string;
  picurl: string;
}

export interface BuildNewsOptions {
  /** 我们自己的站点根（用于 /api/tile 缩略图），尾斜杠会被剥除。 */
  baseUrl: string;
  /** 仓库主页；缺省用 GitHub URL。 */
  htmlUrlOf?: (entry: NewsEntry) => string | undefined;
}

/** 43800 → 43.8k；158300 → 158k；999 → 999。标题空间有限，不写全量数字。 */
export function shortStars(stars: number): string {
  if (!Number.isFinite(stars) || stars < 1000) return String(Math.trunc(stars));
  const k = stars / 1000;
  return k < 100 ? `${Number.isInteger(k) ? k : k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** 全角/宽字符按 2 列计（CJK、全角标点、emoji 大致如此）。 */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

/** 可以作为截断点的字符：空白与中英文标点。 */
const BOUNDARY_RE = /[\s，。、；：！？,.;:!?·…]/;

/**
 * 压缩简介到约 `maxWidth` 列，优先停在标点/空格处，必要时补省略号。
 * 不拆英文单词、不把中文句子切在半个词上。
 */
export function shortSummary(summary: string | undefined, maxWidth = SHORT_SUMMARY_MAX_WIDTH): string {
  const text = (summary ?? '').trim();
  if (text === '') return '';

  const chars = Array.from(text);
  let width = 0;
  let fit = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const next = width + (isWide(chars[i].codePointAt(0) ?? 0) ? 2 : 1);
    if (next > maxWidth) break;
    width = next;
    fit = i + 1;
  }
  if (fit === chars.length) return text;

  // 向左回退到最近的边界；退不到就硬截，至少保留可读的一段。
  for (let i = fit - 1; i > 0; i -= 1) {
    if (BOUNDARY_RE.test(chars[i])) {
      const head = chars.slice(0, i).join('').trimEnd();
      if (head !== '') return `${head}…`;
      break;
    }
  }
  return `${chars.slice(0, fit).join('').trimEnd()}…`;
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

/** 标题头：标记 + 序号 + 仓库 + 星标 + 语言标签（一定可见的部分）。 */
function titleHead(index: number, entry: NewsEntry): string {
  const marker =
    entry.starsDelta >= HOT_DELTA ? '🔥 ' : entry.isNew ? '🆕 ' : '';
  const language = entry.language?.trim();
  const tag = language ? ` · ${language}` : '';
  return `${marker}${index + 1}. ${entry.fullName} ★${shortStars(entry.stars)} (+${entry.starsDelta})${tag}`;
}

/**
 * 组装标题：固定头 + `｜压缩简介`。
 * 头本身超限（极长仓库名）时硬截；简介超限时逐步让位，保证总字节 ≤ 128。
 */
function buildTitle(index: number, entry: NewsEntry): string {
  const head = titleHead(index, entry);
  if (Buffer.byteLength(head, 'utf8') > TITLE_MAX_BYTES) {
    return clipToBytes(head, TITLE_MAX_BYTES);
  }

  const short = shortSummary(entry.summary);
  if (short === '') return head;

  const full = `${head}｜${short}`;
  if (Buffer.byteLength(full, 'utf8') <= TITLE_MAX_BYTES) return full;

  // 从压缩简介里逐字回退，给省略号留位置。
  const separator = '｜';
  const budget = TITLE_MAX_BYTES - Buffer.byteLength(`${head}${separator}…`, 'utf8');
  const chars = Array.from(short.endsWith('…') ? short.slice(0, -1) : short);
  let used = 0;
  let keep = 0;
  for (const char of chars) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > budget) break;
    used += size;
    keep += 1;
  }
  return `${head}${separator}${chars.slice(0, keep).join('').trimEnd()}…`;
}

function tileUrl(baseUrl: string, entry: NewsEntry): string {
  const base = baseUrl.replace(/\/+$/, '');
  const language = entry.language?.trim();
  const query = `repo=${encodeURIComponent(entry.fullName)}${language ? `&lang=${encodeURIComponent(language)}` : ''}`;
  return `${base}/api/tile?${query}`;
}

function ogUrl(fullName: string): string {
  return `https://opengraph.githubassets.com/1/${fullName}`;
}

/**
 * 把条目渲染成 news 文章列表：
 * - 第 1 篇用 OG 海报（多篇布局里唯一的大图）；
 * - 第 2 篇起用我们域名下的 `/api/tile`（头像 → 失败回退语言色块）；
 * - 超过 8 条截断——企微硬上限，多一条整条消息都会被拒。
 */
export function buildNewsArticles(
  entries: NewsEntry[],
  options: BuildNewsOptions,
): NewsArticle[] {
  return entries.slice(0, NEWS_MAX_ARTICLES).map((entry, index) => {
    const htmlUrl = options.htmlUrlOf?.(entry)?.trim();
    return {
      title: buildTitle(index, entry),
      // 多篇布局不显示 description；保留完整简介，客户端若显示则更有信息量。
      ...(entry.summary?.trim() ? { description: entry.summary.trim() } : {}),
      url: htmlUrl !== undefined && htmlUrl !== '' ? htmlUrl : `https://github.com/${entry.fullName}`,
      picurl: index === 0 ? ogUrl(entry.fullName) : tileUrl(options.baseUrl, entry),
    };
  });
}
