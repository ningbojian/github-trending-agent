/**
 * 订阅方向：面向用户的「主题」分类。
 *
 * 为什么不是只按语言：语言只是实现细节（Rust 项目可能是 CLI、也可能是量化），
 * 用户关心的是「我在做什么」。方向在这里被展开成一组关键词，匹配仓库的
 * 名字 / 描述 / topics / 中文简介——和搜索那边的领域词表同一套思路。
 *
 * 约束：只做确定性映射，不调模型；匹配不上时调用方必须降级为自由关键词，
 * 并明确告诉用户「没认出方向」，绝不静默丢弃。
 */

export interface Direction {
  key: string;
  label: string;
  /** 命中仓库的关键词（小写；ASCII 按词边界匹配）。 */
  keywords: string[];
  /** 用户可能输入的说法（小写，精确匹配）。 */
  aliases: string[];
}

export const DIRECTIONS: Direction[] = [
  {
    key: 'agent',
    label: 'AI / Agent',
    keywords: ['agent', 'llm', 'mcp', 'rag', 'copilot', 'gpt', 'claude', 'openai', 'langchain'],
    aliases: ['agent', 'ai', 'aigc', 'llm', '大模型', '智能体', '人工智能', 'ai agent'],
  },
  {
    key: 'frontend',
    label: '前端',
    keywords: ['react', 'vue', 'svelte', 'nextjs', 'next.js', 'tailwind', 'frontend', 'css', 'ui'],
    aliases: ['前端', 'frontend', 'web', '网页'],
  },
  {
    key: 'backend',
    label: '后端',
    keywords: ['backend', 'fastapi', 'django', 'spring', 'nestjs', 'express', 'server', 'api'],
    aliases: ['后端', 'backend', '服务端', '接口'],
  },
  {
    key: 'database',
    label: '数据库',
    keywords: ['database', 'postgres', 'postgresql', 'mysql', 'redis', 'sqlite', 'mongodb', 'orm'],
    aliases: ['数据库', 'database', 'db', '存储', 'sql'],
  },
  {
    key: 'devtools',
    label: '开发工具',
    keywords: ['cli', 'devtool', 'vscode', 'editor', 'terminal', 'shell', 'toolchain'],
    aliases: ['开发工具', '工具', 'devtools', 'cli', '命令行', '编辑器'],
  },
  {
    key: 'media',
    label: '图像 / 音视频',
    keywords: ['image', 'vision', 'video', 'audio', 'speech', 'diffusion', 'ocr', 'ffmpeg'],
    aliases: ['图像', '视觉', '图像识别', '计算机视觉', '音视频', '视频', '音频', '语音', 'ocr'],
  },
  {
    key: 'embedded',
    label: '嵌入式 / IoT',
    keywords: ['embedded', 'firmware', 'arduino', 'esp32', 'rtos', 'iot', 'microcontroller'],
    aliases: ['嵌入式', '嵌入式开发', '单片机', '物联网', 'iot', '硬件', '固件'],
  },
  {
    key: 'security',
    label: '安全',
    keywords: ['security', 'crypto', 'vulnerability', 'pentest', 'exploit', 'audit', 'auth'],
    aliases: ['安全', '网络安全', '信息安全', '加密', '渗透', '漏洞'],
  },
  {
    key: 'data',
    label: '数据 / 分析',
    keywords: ['data', 'analytics', 'etl', 'pandas', 'spark', 'visualization', 'bi', 'dataset'],
    aliases: ['数据', '数据分析', '数据可视化', '可视化', 'bi', '爬虫', '抓取'],
  },
  {
    key: 'game',
    label: '游戏',
    keywords: ['game', 'unity', 'godot', 'unreal', 'gaming', 'engine'],
    aliases: ['游戏', 'game', '游戏开发'],
  },
  {
    key: 'systems',
    label: '系统 / 编译器',
    keywords: ['kernel', 'compiler', 'runtime', 'wasm', 'operating system', 'virtual machine', 'vm'],
    aliases: ['系统', '编译器', '内核', '操作系统', 'runtime', '虚拟机'],
  },
  {
    key: 'quant',
    label: '量化 / 金融',
    keywords: ['quant', 'trading', 'finance', 'backtest', 'stock'],
    aliases: ['量化', '金融', '交易', '炒股', '股票'],
  },
];

const BY_KEY = new Map(DIRECTIONS.map((direction) => [direction.key, direction]));
const BY_ALIAS = new Map<string, Direction>();
for (const direction of DIRECTIONS) {
  BY_ALIAS.set(direction.key, direction);
  for (const alias of direction.aliases) BY_ALIAS.set(alias, direction);
}

/** 用户输入的说法 → 方向；认不出返回 null（调用方降级为关键词）。 */
export function directionByAlias(token: string): Direction | null {
  return BY_ALIAS.get(token.trim().toLowerCase()) ?? null;
}

/** 方向 key 的展示名；未知 key 原样返回。 */
export function directionLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/**
 * 把用户输入的一串词拆成「方向 + 关键词」。
 * 认得出的进 topics，认不出的原样留在 keywords —— 不丢任何输入。
 */
export function splitDirectionTokens(tokens: string[]): {
  topics: string[];
  keywords: string[];
} {
  const topics: string[] = [];
  const keywords: string[] = [];
  for (const token of tokens) {
    const direction = directionByAlias(token);
    if (direction) {
      if (!topics.includes(direction.key)) topics.push(direction.key);
    } else if (!keywords.includes(token)) {
      keywords.push(token);
    }
  }
  return { topics, keywords };
}

const ASCII_KEYWORD_RE_CACHE = new Map<string, RegExp>();

function asciiKeywordRe(keyword: string): RegExp {
  const cached = ASCII_KEYWORD_RE_CACHE.get(keyword);
  if (cached) return cached;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  ASCII_KEYWORD_RE_CACHE.set(keyword, re);
  return re;
}

/** 仓库是否命中某个方向（名字 / 描述 / topics / 中文简介 / 短句）。 */
export function matchesDirection(
  item: {
    fullName: string;
    description?: string | null;
    topics?: unknown;
    summary?: string;
    short?: string;
  },
  directionKey: string,
): boolean {
  const direction = BY_KEY.get(directionKey);
  if (!direction) return false;
  const tags = Array.isArray(item.topics)
    ? item.topics.map((tag) => String(tag)).join(' ')
    : '';
  const haystack = [
    item.fullName,
    item.description ?? '',
    tags,
    item.summary ?? '',
    item.short ?? '',
  ]
    .join(' ')
    .toLowerCase();

  return direction.keywords.some((keyword) => {
    if (/^[a-z0-9 .+-]+$/i.test(keyword)) {
      return asciiKeywordRe(keyword).test(haystack);
    }
    return haystack.includes(keyword);
  });
}

/** 方向过滤：命中任一方向即保留；全都没命中时退回原列表（避免空简报）。 */
export function filterByDirections<T extends {
  fullName: string;
  description?: string | null;
  topics?: unknown;
  summary?: string;
  short?: string;
}>(items: T[], topics: string[]): T[] {
  if (topics.length === 0) return items;
  const matched = items.filter((item) =>
    topics.some((topic) => matchesDirection(item, topic)),
  );
  return matched.length > 0 ? matched : items;
}
