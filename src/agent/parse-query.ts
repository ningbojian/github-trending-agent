import { z } from 'zod';
import { generateObjectSafe, type LlmChoice } from './llm.js';

/** LLM 结构化解析的输出契约（检索服务 Task 8 消费）。 */
export const SearchQuerySchema = z.object({
  /**
   * 一级意图：search = 找项目；about = 问这个产品是谁；off_topic = 明显无关。
   * 规则层（intent.ts）已经拦掉高置信的短句，这里主要接住换过说法的长句。
   */
  intent: z.enum(['search', 'about', 'off_topic']),
  languages: z.array(z.string()),
  keywords: z.array(z.string()),
  period: z.enum(['today', 'week', 'month', 'all']),
  minStars: z.number().nullable(),
  sortBy: z.enum(['stars_delta', 'stars', 'new']),
  topN: z.number(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** 文本无任何信号时的默认查询。 */
const DEFAULT_SEARCH_QUERY: SearchQuery = {
  intent: 'search',
  languages: [],
  keywords: [],
  period: 'week',
  minStars: null,
  sortBy: 'stars_delta',
  topN: 10,
};

const TOP_N_MIN = 1;
const TOP_N_MAX = 25;

/** 关键词标点清洗：去掉中英文标点与首尾空白；清洗后为空串则由调用方丢弃。 */
const KEYWORD_PUNCT_RE = /[。！？!?；;，,、()（）]/g;

function cleanKeyword(raw: string): string {
  return raw.replace(KEYWORD_PUNCT_RE, '').trim();
}

/**
 * LLM 输出不可信，统一归一化：语言小写去空白、关键词去标点、
 * topN 钳位到 1..25、minStars ≥ 0。
 */
function normalizeQuery(query: SearchQuery): SearchQuery {
  const languages = query.languages.map((l) => l.trim().toLowerCase()).filter(Boolean);
  const keywords = query.keywords.map(cleanKeyword).filter(Boolean);
  const minStars =
    query.minStars === null || !Number.isFinite(query.minStars)
      ? null
      : Math.max(0, Math.round(query.minStars));
  const topN = Number.isFinite(query.topN)
    ? Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, Math.round(query.topN)))
    : DEFAULT_SEARCH_QUERY.topN;
  return { ...query, languages, keywords, minStars, topN };
}

/**
 * Few-shot 示例 ≥ 3 个；铁律：只允许从文本推断，禁止编造。
 */
function buildPrompt(text: string): string {
  return [
    '你是 GitHub Trending 查询解析器。把用户消息解析成结构化 JSON。',
    '字段：intent（search|about|off_topic）、languages（编程语言，小写）、',
    'keywords（主题词，文本未提及则为空数组）、',
    "period（today|week|month|all）、minStars（star 数门槛，未提及为 null）、",
    "sortBy（stars_delta|stars|new）、topN（返回条数，默认 10）。",
    'intent 判定：在问这个产品「你是谁/能干什么」→ about；',
    '与 GitHub 找项目完全无关（天气、股票、翻译、写诗、报时…）→ off_topic；',
    '其余一律 search —— 「看看热榜」「今天有什么」都属于 search，绝不判成 off_topic。',
    '铁律：只允许从给定文本推断，禁止编造文本中没有的信息；无信号的字段一律用默认值。',
    '「比较火」「热门」「流行」只表示热度排序（sortBy），不得作为 keywords。',
    '',
    '示例 1',
    '输入：本周 python 里 ai 相关的',
    '输出：{"intent":"search","languages":["python"],"keywords":["ai"],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    '',
    '示例 2',
    '输入：帮我看下最近 star 增长快的 rust 项目',
    '输出：{"intent":"search","languages":["rust"],"keywords":[],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    '',
    '示例 3',
    '输入：本月 typescript star 超过 10k 的前 5 个新项目',
    '输出：{"intent":"search","languages":["typescript"],"keywords":[],"period":"month","minStars":10000,"sortBy":"new","topN":5}',
    '',
    '示例 4',
    '输入：啊',
    '输出：{"intent":"search","languages":[],"keywords":[],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    '',
    '示例 5',
    '输入：找一下本周比较火的Java项目',
    '输出：{"intent":"search","languages":["java"],"keywords":[],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    '',
    '示例 6',
    '输入：你都会些啥',
    '输出：{"intent":"about","languages":[],"keywords":[],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    '',
    '示例 7',
    '输入：明天下雨吗',
    '输出：{"intent":"off_topic","languages":[],"keywords":[],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    '',
    `输入：${text}`,
    '输出：',
  ].join('\n');
}

/** 归一化语言名：golang→go、js→javascript、ts→typescript 等。别名长的先匹配，避免误吞。 */
const LANGUAGE_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: 'typescript', aliases: ['typescript', 'ts'] },
  { canonical: 'javascript', aliases: ['javascript', 'js'] },
  { canonical: 'python', aliases: ['python', 'py'] },
  { canonical: 'rust', aliases: ['rust'] },
  { canonical: 'go', aliases: ['golang', 'go'] },
  { canonical: 'c++', aliases: ['c++', 'cpp'] },
  { canonical: 'c#', aliases: ['c#', 'csharp'] },
  // html/css/vue 先于 c 注册：c 的正则带边界断言本就不会吞 css/c++，此处顺序仅作显式防御
  { canonical: 'html', aliases: ['html'] },
  { canonical: 'css', aliases: ['css'] },
  { canonical: 'vue', aliases: ['vue'] },
  { canonical: 'c', aliases: ['c'] },
  { canonical: 'java', aliases: ['java'] },
  { canonical: 'kotlin', aliases: ['kotlin'] },
  { canonical: 'swift', aliases: ['swift'] },
  { canonical: 'ruby', aliases: ['ruby'] },
  { canonical: 'php', aliases: ['php'] },
  { canonical: 'scala', aliases: ['scala'] },
  { canonical: 'dart', aliases: ['dart'] },
  { canonical: 'lua', aliases: ['lua'] },
  { canonical: 'shell', aliases: ['shell', 'bash'] },
  { canonical: 'elixir', aliases: ['elixir'] },
  { canonical: 'haskell', aliases: ['haskell'] },
  { canonical: 'zig', aliases: ['zig'] },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 关键词剔除词表：虚词/时间词/排序词/平台词。
 * 填充词只做 token 级判定（完整覆盖→丢弃、尾剥、前导剥），绝无全局子串 replace——
 * 否则会把「比较器」剥空、「推荐系统」漏出过宽的「系统」。
 * 刻意不加裸单字填充词（找/火/要）：独立单字 token 本就被 length<2 过滤，
 * 裸单字入表只会在覆盖/剥除判定里增加误伤复合词（「火狐」类）的机会，无收益。
 */
const KEYWORD_FILLERS = [
  '帮我看下', '帮我看看', '请问', '帮我', '我想', '看看', '看下', '请',
  '找一下', '一下', '最近几天', '比较火', '比较', '热门', '流行', '一些', '推荐', '麻烦', '想要', '给我',
  '这个星期', '这个月', '最近一周', '近一周', '最近', '近期', '本周', '这周', '本月', '今天', '今日',
  '新上榜', '新项目', '增长快', '涨幅快', '涨得快', '飙升', '涨幅', '增长', '上升', '最多', '最高', '总数',
  '最新', '新进', '新',
  'star', 'stars', 'github', 'trending', 'top',
  '代码库', '项目', '仓库', '代码', '开源',
  '相关', '哪些', '什么', '怎么', '如何',
  '超过', '大于', '不低于', '以上',
  '的', '了', '在', '里', '和', '与', '或', '等',
  '前', '个', '条', '篇', '款', '快',
];

/** 填充词按长度倒序（贪心匹配：长词先命中，「比较火」先于「比较」）。 */
const FILLERS_LONGEST_FIRST = [...KEYWORD_FILLERS].sort((a, b) => b.length - a.length);

/**
 * 规则 a：贪心（长词优先）尝试用填充词完整覆盖 token；每个位置都命中才返回 true。
 * 命中即整 token 丢弃——纯虚词串（「找一下本周比较火的」）的唯一出口。
 */
function isAllFillers(token: string): boolean {
  let i = 0;
  while (i < token.length) {
    const filler = FILLERS_LONGEST_FIRST.find((f) => token.startsWith(f, i));
    if (filler === undefined) return false;
    i += filler.length;
  }
  return true;
}

/**
 * 规则 b：只剥尾部填充词（最长优先、循环）；
 * 每次剥完剩余长度须 ≥2，否则不剥——防止把 token 剥成单字残渣。
 */
function stripTrailingFillers(token: string): string {
  let tok = token;
  for (;;) {
    const filler = FILLERS_LONGEST_FIRST.find(
      (f) => f.length < tok.length && tok.endsWith(f),
    );
    if (filler === undefined) break;
    if (tok.length - filler.length < 2) break; // 剩余 <2 不剥
    tok = tok.slice(0, tok.length - filler.length);
  }
  return tok;
}

/**
 * 规则 c：剥前导填充词（最长优先、循环）；
 * 仅当剥完剩余长度 ≥3 才执行——「帮我看看人工智能」→「人工智能」，
 * 而「比较器」「推荐系统」「流行病学」因剩余只有 1–2 字而整词保留。
 */
function stripLeadingFillers(token: string): string {
  let tok = token;
  for (;;) {
    const filler = FILLERS_LONGEST_FIRST.find(
      (f) => f.length < tok.length && tok.startsWith(f),
    );
    if (filler === undefined) break;
    if (tok.length - filler.length < 3) break; // 剩余 <3 不剥
    tok = tok.slice(filler.length);
  }
  return tok;
}

/**
 * 纯函数回退解析：LLM 不可用时按正则/词表推断。无 I/O、无 LLM。
 * period：`本周|今天|本月` 等 → today|week|month|all；languages：别名表匹配；
 * 其余剔除虚词后的词 → keywords。
 */
export function fallbackParse(text: string): SearchQuery {
  const lower = text.toLowerCase();

  // period
  let period: SearchQuery['period'] = DEFAULT_SEARCH_QUERY.period;
  if (/今天|今日|当天|tonight/.test(lower)) period = 'today';
  else if (/本月|这个月|当月/.test(lower)) period = 'month';
  else if (/所有时间|全部时间|历史榜单|历史/.test(lower)) period = 'all';
  else if (/本周|这周|这个星期|最近一周|近一周|一周/.test(lower)) period = 'week';

  // languages：长别名先匹配并从工作文本中剔除，避免 c 吞掉 c++
  let working = lower;
  const languages: string[] = [];
  for (const { canonical, aliases } of LANGUAGE_ALIASES) {
    for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(?<![a-z0-9+#])${escapeRegExp(alias)}(?![a-z0-9])`, 'g');
      const replaced = working.replace(re, ' ');
      if (replaced !== working) {
        if (!languages.includes(canonical)) languages.push(canonical);
        working = replaced;
      }
    }
  }

  // minStars："5000 star"、"10k star"、"star 超过 1万"
  let minStars: number | null = null;
  const numStar = lower.match(/(\d+(?:\.\d+)?)\s*(k|w|万)?\s*(?:个)?\s*(?:stars?|星)/);
  const starNum = lower.match(/(?:stars?|星)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*(k|w|万)?/);
  const numMatch = numStar ?? starNum;
  if (numMatch?.[1] !== undefined) {
    const unit = numMatch[2];
    const mult = unit === 'k' ? 1000 : unit === 'w' || unit === '万' ? 10000 : 1;
    minStars = Math.round(Number.parseFloat(numMatch[1]) * mult);
  }

  // topN："前 5"、"top 5"、"5 个"；数字两侧排除相邻数字，避免从 5000 里截出 00
  let topN = DEFAULT_SEARCH_QUERY.topN;
  const topMatch =
    lower.match(/(?:前|top)\s*(\d{1,2})(?!\d)/) ?? lower.match(/(?<!\d)(\d{1,2})\s*(?:个|条|篇)(?!\d)/);
  if (topMatch?.[1] !== undefined) {
    const n = Number.parseInt(topMatch[1], 10);
    topN = Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, n));
  }

  // sortBy
  let sortBy: SearchQuery['sortBy'] = DEFAULT_SEARCH_QUERY.sortBy;
  if (/(?:star|星)[^,。;]{0,12}(?:最多|最高|总数)|(?:最多|最高)(?:star|星)/.test(lower)) {
    sortBy = 'stars';
  } else if (/最新|新上榜|新项目|新进/.test(lower)) {
    sortBy = 'new';
  } else if (
    /(?:star|星)[^,。;]{0,12}(?:增长|涨幅|飙升|上升|变快|快)|(?:增长|涨幅|飙升)[^,。;]{0,12}(?:star|星)/.test(
      lower,
    )
  ) {
    sortBy = 'stars_delta';
  }

  // keywords：先按现有正则分词（ASCII token 与 CJK run），填充词只做 token 级判定：
  // a. 整 token 被填充词完整覆盖 → 丢弃；b. 尾部剥填充词（剩余 ≥2）；
  // c. 前导剥填充词（剩余 ≥3）；d. 其余整词保留——绝不做中间插入式剔除。
  const keywords: string[] = [];
  const tokens = working.match(/[a-z0-9+#][a-z0-9+#.\-]*|[一-鿿]+/g) ?? [];
  for (const raw of tokens) {
    let token = raw;
    if (isAllFillers(token)) continue; // a：纯虚词串整 token 丢弃
    if (/^[一-鿿]+$/.test(token)) {
      token = stripTrailingFillers(token); // b：只剥尾部
      token = stripLeadingFillers(token); // c：剥前导（剩余 ≥3 才剥）
    }
    // d：其余原样保留，随后走统一过滤
    const cleaned = cleanKeyword(token);
    if (!cleaned) continue; // 清洗后为空的纯标点 token 丢弃
    if (/^\d+$/.test(cleaned)) continue; // 纯数字是 star 数/条数，不是关键词
    if (cleaned.length < 2) continue; // 单字噪声（的、里、前…）不入关键词
    if (!keywords.includes(cleaned)) keywords.push(cleaned);
  }

  return {
    intent: 'search',
    languages,
    keywords,
    period,
    minStars,
    sortBy,
    topN,
  };
}

/**
 * 先 LLM 结构化解析（严格 prompt：只允许从文本推断，禁止编造）；
 * generateObjectSafe 返回 null（SDK 失败/校验失败/未知提供商）时回退 fallbackParse。
 *
 * `choice` 决定用谁的 Key：默认运营方；互动传 `{ kind: 'none' }`（用户没配 Key）
 * 时**完全不调模型**，直接规则解析 —— 零成本。
 */
export async function parseSearchQuery(
  text: string,
  choice: LlmChoice = { kind: 'operator' },
): Promise<SearchQuery> {
  if (choice.kind === 'none') {
    return fallbackParse(text);
  }
  // 运营方路径保持两参调用（既有测试/诊断记录的入参形状不变）。
  const result =
    choice.kind === 'user'
      ? await generateObjectSafe(SearchQuerySchema, buildPrompt(text), choice.config)
      : await generateObjectSafe(SearchQuerySchema, buildPrompt(text));
  if (result === null) {
    return fallbackParse(text);
  }
  return normalizeQuery(result);
}
