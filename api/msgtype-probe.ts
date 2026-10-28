import { env } from '../src/config.js';
import { postMessage } from '../src/wecom/api.js';

/**
 * 【临时探针 v4，测完即删】v3 的结论：首篇简介被截断、头像放大成大图太丑
 * （首篇必须用 OG 海报）；第 2 篇之后头像缩略图 + 标题里的简介是可行的。
 *
 * 这一轮只补最后两块数据，然后就开始实现：
 * A. 八篇布局下，首篇简介区到底能显示多少字？（用〔N〕分段，看最后一个可见编号）
 * B. 第 2 篇之后的标题能放多少字？（标题里同样塞〔N〕分段）
 * C. 🔥 热度标记 + 「· Go」语言标签 + 压缩简介 的实际观感。
 *
 * 用法：GET /api/msgtype-probe?secret=<CRON_SECRET>&u=<userid>
 */

export const maxDuration = 60;

interface ProbeRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

interface ProbeResponse {
  status(code: number): ProbeResponse;
  setHeader(name: string, value: string): ProbeResponse | void;
  send(body: string): unknown;
}

function queryParam(req: ProbeRequest, name: string): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function bearerToken(req: ProbeRequest): string {
  const raw = req.headers?.['authorization'];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
}

interface Sample {
  name: string;
  owner: string;
  language: string;
  stars: number;
  delta: number;
  zh: string;
  shortZh: string;
}

const SAMPLES: Sample[] = [
  { name: 'astral-sh/ruff', owner: 'astral-sh', language: 'Rust', stars: 41200, delta: 320, zh: '用 Rust 写的极快 Python linter，一个工具替代 flake8、isort 与部分 black', shortZh: '极快的 Python linter' },
  { name: 'ollama/ollama', owner: 'ollama', language: 'Go', stars: 158300, delta: 610, zh: '一条命令在本地跑起 Llama、Qwen、DeepSeek 等大模型，自带模型仓库', shortZh: '本地一条命令跑大模型' },
  { name: 'ggml-org/llama.cpp', owner: 'ggml-org', language: 'C++', stars: 92100, delta: 240, zh: '纯 C/C++ 的大模型推理实现，无依赖，CPU 与消费级显卡都能跑', shortZh: 'CPU 上跑大模型推理' },
  { name: 'langchain-ai/langchain', owner: 'langchain-ai', language: 'Python', stars: 118700, delta: 180, zh: '把大模型、检索与工具串成应用的开发框架', shortZh: '大模型应用开发框架' },
  { name: 'vercel/next.js', owner: 'vercel', language: 'TypeScript', stars: 132500, delta: 150, zh: 'React 全栈框架，服务端渲染与路由开箱即用', shortZh: 'React 全栈框架' },
  { name: 'microsoft/vscode', owner: 'microsoft', language: 'TypeScript', stars: 172800, delta: 90, zh: '微软开源的代码编辑器，插件生态覆盖所有语言', shortZh: '微软开源代码编辑器' },
  { name: 'neovim/neovim', owner: 'neovim', language: 'Lua', stars: 84300, delta: 70, zh: 'Vim 的现代重构版，内置 LSP 与 Lua 配置', shortZh: 'Vim 的现代重构版' },
  { name: 'rustdesk/rustdesk', owner: 'rustdesk', language: 'Rust', stars: 96500, delta: 520, zh: '开源自托管远程桌面，数据可留在自己服务器', shortZh: '自托管远程桌面' },
];

function ogPic(name: string): string {
  return `https://opengraph.githubassets.com/1/${name}`;
}

function avatarPic(name: string): string {
  // 走自己的代理：企微直连 avatars.githubusercontent.com 会随机取不到（灰头像）。
  const base = env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? 'https://ghtrending.cyou';
  return `${base}/api/avatar?repo=${encodeURIComponent(name)}`;
}

function shortStars(stars: number): string {
  if (stars < 1000) return String(stars);
  const k = stars / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** 12 段，每段 5 个汉字，便于肉眼报出「最后看到的编号」。 */
const SEGMENTS = [
  '一二三四五',
  '六七八九十',
  '百千万亿兆',
  '甲乙丙丁戊',
  '己庚辛壬癸',
  '子丑寅卯辰',
  '巳午未申酉',
  '戌亥风雨雷',
  '春夏秋冬四',
  '东南西北上',
  '金木水火土',
  '日月星辰山',
];

function calibrationDescription(): string {
  return SEGMENTS.map((seg, i) => `〔${i + 1}〕${seg}`).join('');
}

function article(
  sample: Sample,
  opts: {
    index: number;
    lead?: string;
    description: string;
    titleSuffix?: string;
    hot?: boolean;
    pic: 'og' | 'avatar';
  },
): Record<string, unknown> {
  const hot = opts.hot === true ? '🔥 ' : '';
  const lead = opts.index === 0 ? `${opts.lead ?? ''} ` : '';
  return {
    title: `${lead}${hot}${opts.index + 1}. ${sample.name} ★${shortStars(sample.stars)} (+${sample.delta})${opts.titleSuffix ?? ''}`,
    description: opts.description,
    url: `https://github.com/${sample.name}`,
    picurl: opts.pic === 'og' ? ogPic(sample.name) : avatarPic(sample.owner),
  };
}

/** A：校准简介与标题容量。首篇用 OG + 分段简介；其余标题里塞 4 段。 */
function calibrationArticles(): Array<Record<string, unknown>> {
  return SAMPLES.slice(0, 8).map((sample, index) =>
    article(sample, {
      index,
      lead: '【A 校准·看最后可见编号】',
      description:
        index === 0
          ? calibrationDescription()
          : sample.zh,
      titleSuffix:
        index === 0
          ? ''
          : `｜${SEGMENTS.slice(0, 4).map((seg, i) => `〔${i + 1}〕${seg}`).join('')}`,
      pic: index === 0 ? 'og' : 'avatar',
    }),
  );
}

/** B：生产预览——🔥 标记 + 语言标签 + 压缩简介。 */
function previewArticles(): Array<Record<string, unknown>> {
  return SAMPLES.slice(0, 8).map((sample, index) =>
    article(sample, {
      index,
      lead: '【B 生产预览】',
      description: sample.zh,
      titleSuffix: ` · ${sample.language}｜${sample.shortZh}`,
      hot: sample.delta >= 300,
      pic: index === 0 ? 'og' : 'avatar',
    }),
  );
}

export default async function handler(
  req: ProbeRequest,
  res: ProbeResponse,
): Promise<void> {
  const expected = env.CRON_SECRET ?? '';
  const provided = queryParam(req, 'secret') || bearerToken(req);
  if (expected === '' || provided !== expected) {
    res.status(401).send('unauthorized');
    return;
  }

  const userid = queryParam(req, 'u').trim();
  if (userid === '') {
    res.status(400).send(JSON.stringify({ error: 'missing ?u=<wecom userid>' }));
    return;
  }

  const agentid = Number(env.WECOM_AGENT_ID);
  const cases: Array<{ label: string; articles: Array<Record<string, unknown>> }> = [
    { label: 'calibration', articles: calibrationArticles() },
    { label: 'preview', articles: previewArticles() },
  ];

  const results: Array<{ type: string; ok: boolean; error?: string }> = [];
  for (const item of cases) {
    try {
      await postMessage(userid, {
        touser: userid,
        agentid,
        msgtype: 'news',
        news: { articles: item.articles },
      });
      results.push({ type: item.label, ok: true });
    } catch (err) {
      results.push({
        type: item.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ userid, results }, null, 2));
}
