import { env } from '../src/config.js';
import { postMessage } from '../src/wecom/api.js';

/**
 * 【临时探针 v3，测完即删】v2 的结论：news 一条最多 8 篇（9 篇报 45008）；
 * 微信里八篇全部展开；首篇大图 + 标题 + 完整简介；第 2 篇之后只有方形缩略图
 * 和标题。问题是 OG 图是 1200×630 的「仓库名文字海报」，缩成方块只会裁到
 * 一块文字，观感像截图而不是图标。
 *
 * 这一轮只验证两件事：
 * 1. 方形缩略图换成**仓库所有者的头像**（正方形，200px）会不会像样；
 * 2. 第 2 篇之后只有标题可见，把中文简介压进标题（≤128 字节）能显示多少。
 *
 * 三条消息：混合（首篇 OG + 其余头像，3 篇）、全头像 8 篇、全头像 3 篇
 * （看方图放大成首篇大图是否可接受）。
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
  stars: number;
  delta: number;
  zh: string;
}

const SAMPLES: Sample[] = [
  { name: 'astral-sh/ruff', owner: 'astral-sh', stars: 41200, delta: 320, zh: '用 Rust 写的极快 Python linter，一个工具替代 flake8、isort 与部分 black' },
  { name: 'ollama/ollama', owner: 'ollama', stars: 158300, delta: 610, zh: '一条命令在本地跑起 Llama、Qwen、DeepSeek 等大模型，自带模型仓库' },
  { name: 'ggml-org/llama.cpp', owner: 'ggml-org', stars: 92100, delta: 240, zh: '纯 C/C++ 的大模型推理实现，无依赖，CPU 与消费级显卡都能跑' },
  { name: 'langchain-ai/langchain', owner: 'langchain-ai', stars: 118700, delta: 180, zh: '把大模型、检索与工具串成应用的开发框架' },
  { name: 'vercel/next.js', owner: 'vercel', stars: 132500, delta: 150, zh: 'React 全栈框架，服务端渲染与路由开箱即用' },
  { name: 'microsoft/vscode', owner: 'microsoft', stars: 172800, delta: 90, zh: '微软开源的代码编辑器，插件生态覆盖所有语言' },
  { name: 'neovim/neovim', owner: 'neovim', stars: 84300, delta: 70, zh: 'Vim 的现代重构版，内置 LSP 与 Lua 配置' },
  { name: 'rustdesk/rustdesk', owner: 'rustdesk', stars: 96500, delta: 210, zh: '开源自托管远程桌面，数据可留在自己服务器' },
  { name: 'openai/whisper', owner: 'openai', stars: 88700, delta: 130, zh: '多语言语音识别与转写模型' },
];

/** 仓库封面海报（1200×630），适合首篇大图。 */
function ogPic(name: string): string {
  return `https://opengraph.githubassets.com/1/${name}`;
}

/** 所有者头像（正方形），适合第 2 篇之后的方形缩略图；无需先解析重定向。 */
function avatarPic(owner: string): string {
  return `https://avatars.githubusercontent.com/${owner}`;
}

/** 43800 → 43.8k；标题空间有限，别写全量数字。 */
function shortStars(stars: number): string {
  if (stars < 1000) return String(stars);
  const k = stars / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** 简介压进标题：汉字按 3 字节算，留出仓库名与星标的空间，最多约 16 字。 */
function shortZh(zh: string): string {
  const chars = Array.from(zh);
  const max = 16;
  return chars.length <= max ? zh : `${chars.slice(0, max).join('')}…`;
}

/**
 * 生产式布局：首篇「大图 + 标题 + 完整简介」；第 2 篇起只看得到缩略图和标题，
 * 所以标题里带一段压缩简介。`firstPic` 决定首篇用 OG 海报还是头像。
 */
function articles(
  count: number,
  lead: string,
  firstPic: 'og' | 'avatar',
): Array<Record<string, unknown>> {
  return SAMPLES.slice(0, count).map((sample, index) => {
    const star = `★${shortStars(sample.stars)} (+${sample.delta})`;
    const first = index === 0;
    return {
      title: first
        ? `${lead} 1. ${sample.name} ${star}`
        : `${index + 1}. ${sample.name} ${star}｜${shortZh(sample.zh)}`,
      description: sample.zh,
      url: `https://github.com/${sample.name}`,
      picurl:
        first && firstPic === 'og' ? ogPic(sample.name) : avatarPic(sample.owner),
    };
  });
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
  const cases: Array<{ label: string; count: number; lead: string; firstPic: 'og' | 'avatar' }> = [
    { label: 'mixed-3', count: 3, lead: '【1/3 首篇OG其余头像】', firstPic: 'og' },
    { label: 'avatar-8', count: 8, lead: '【2/3 八篇·全头像】', firstPic: 'avatar' },
    { label: 'avatar-3', count: 3, lead: '【3/3 三篇·全头像】', firstPic: 'avatar' },
  ];

  const results: Array<{ type: string; ok: boolean; error?: string }> = [];
  for (const item of cases) {
    try {
      await postMessage(userid, {
        touser: userid,
        agentid,
        msgtype: 'news',
        news: { articles: articles(item.count, item.lead, item.firstPic) },
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
