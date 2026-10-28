import { env } from '../src/config.js';
import { postMessage } from '../src/wecom/api.js';

/**
 * 【临时探针 v2，测完即删】第一轮确认了个人微信能显示 textcard / news，
 * 但没测图片；也没测 news 一条到底能放几篇。这一轮只回答两个问题：
 *
 * 1. 带 `picurl` 的 news，在个人微信里有没有图？多篇时第 2 篇之后有没有缩略图？
 *    —— 决定「一条聚合卡片」方案成不成立。
 * 2. news 的 8 篇上限是硬限制还是文档过时？（第 4 条故意发 9 篇）
 *
 * 图片用 GitHub 的 opengraph 图（每仓库的自动封面），不额外存图。
 * 发送仍复用生产 postMessage：token、中转、重试、errcode 校验必须一致。
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
  stars: number;
  delta: number;
  zh: string;
}

/** 真实仓库 + 真实字号的中文简介，观感才可信；第 9 个用于探 8 篇上限。 */
const SAMPLES: Sample[] = [
  { name: 'astral-sh/ruff', stars: 41200, delta: 320, zh: '用 Rust 写的极快 Python linter，一个工具替代 flake8、isort 与部分 black' },
  { name: 'ollama/ollama', stars: 158300, delta: 610, zh: '一条命令在本地跑起 Llama、Qwen、DeepSeek 等大模型，自带模型仓库' },
  { name: 'ggml-org/llama.cpp', stars: 92100, delta: 240, zh: '纯 C/C++ 的大模型推理实现，无依赖，CPU 与消费级显卡都能跑' },
  { name: 'langchain-ai/langchain', stars: 118700, delta: 180, zh: '把大模型、检索与工具串成应用的开发框架，支持多模型与多向量库' },
  { name: 'vercel/next.js', stars: 132500, delta: 150, zh: 'React 全栈框架，服务端渲染、路由与静态生成开箱即用' },
  { name: 'microsoft/vscode', stars: 172800, delta: 90, zh: '微软开源的代码编辑器，插件生态覆盖几乎所有语言与工作流' },
  { name: 'neovim/neovim', stars: 84300, delta: 70, zh: 'Vim 的现代重构版，内置 LSP、异步插件与 Lua 配置' },
  { name: 'rustdesk/rustdesk', stars: 96500, delta: 210, zh: '开源自托管远程桌面，替代 TeamViewer，数据可以完全留在自己服务器' },
  { name: 'openai/whisper', stars: 88700, delta: 130, zh: '多语言语音识别与转写模型，支持时间轴与翻译' },
];

/** GitHub 自动生成的仓库封面（1200×630 PNG），无需自己存图。 */
function coverPic(name: string): string {
  return `https://opengraph.githubassets.com/1/${name}`;
}

/**
 * 构造 news 文章列表。`label` 只加在第一篇标题上——第 2 篇之后标题保持
 * 生产样式，才能看出微信到底显示了多少信息。
 */
function articles(count: number, label: string): Array<Record<string, unknown>> {
  return SAMPLES.slice(0, count).map((sample, index) => ({
    title:
      (index === 0 ? `${label} ` : '') +
      `${index + 1}. ${sample.name} ★${sample.stars} (+${sample.delta})`,
    description: sample.zh,
    url: `https://github.com/${sample.name}`,
    picurl: coverPic(sample.name),
  }));
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
  const cases: Array<{ label: string; count: number; lead: string }> = [
    { label: 'news-1-pic', count: 1, lead: '【1/4 单篇+图】' },
    { label: 'news-3-pic', count: 3, lead: '【2/4 三篇+图】' },
    { label: 'news-8-pic', count: 8, lead: '【3/4 八篇+图】' },
    { label: 'news-9-pic', count: 9, lead: '【4/4 九篇·应超限】' },
  ];

  const results: Array<{ type: string; ok: boolean; error?: string }> = [];
  for (const item of cases) {
    try {
      await postMessage(userid, {
        touser: userid,
        agentid,
        msgtype: 'news',
        news: { articles: articles(item.count, item.lead) },
      });
      results.push({ type: item.label, ok: true });
    } catch (err) {
      results.push({
        type: item.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 间隔 600ms：这一轮每篇都要企微去抓图，比纯文本更值得错开
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ userid, results }, null, 2));
}
