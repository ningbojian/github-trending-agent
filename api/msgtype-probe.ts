import { env } from '../src/config.js';
import { postMessage } from '../src/wecom/api.js';

/**
 * 【临时探针，测完即删】把同一份内容用五种 msgtype 各发一遍，
 * 用来实测「个人微信（微信插件）能显示哪几种、显示成什么样」。
 *
 * 为什么要在线上跑：企微的 WECOM_CORP_ID / WECOM_SECRET 只配在 Vercel，
 * 本地 `.env` 里是占位符，本地脚本连不上。
 *
 * 为什么复用 postMessage：token、出站中转、重试、errcode 校验必须和生产一致，
 * 否则测出来的行为不可信。
 *
 * 鉴权复用 CRON_SECRET（与 /api/metrics、/api/trace 同一把钥匙）。
 *
 * 用法：GET /api/msgtype-probe?secret=<CRON_SECRET>&u=<你的userid>
 */

export const maxDuration = 30;

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

/** 探针内容：用真实字号的仓库名与中文简介，观感才可信。 */
const SAMPLES = [
  { name: 'astral-sh/ruff', zh: '用 Rust 写的极快 Python linter，替代 flake8 与 isort' },
  { name: 'ollama/ollama', zh: '本地一条命令跑起 Llama、Qwen 等大模型' },
  { name: 'ggml-org/llama.cpp', zh: '纯 C/C++ 的大模型推理实现，无依赖可在 CPU 上跑' },
];

function textPayload(): Record<string, unknown> {
  return {
    msgtype: 'text',
    text: {
      content:
        '【1/5 纯文本】对照组，就是现在生产在用的格式\n' +
        SAMPLES.map((s, i) => `${i + 1}. ${s.name} ★12000 (+300) — ${s.zh} https://github.com/${s.name}`).join('\n'),
    },
  };
}

function textcardPayload(): Record<string, unknown> {
  const sample = SAMPLES[0];
  return {
    msgtype: 'textcard',
    textcard: {
      title: '【2/5 文本卡片】astral-sh/ruff',
      description: `${sample.zh}。★12000 (+300)。这是 textcard 的描述区，最多 512 字节。`,
      url: `https://github.com/${sample.name}`,
      btntxt: '查看仓库',
    },
  };
}

function newsPayload(count: number, label: string): Record<string, unknown> {
  return {
    msgtype: 'news',
    news: {
      articles: SAMPLES.slice(0, count).map((s) => ({
        title: `${label} ${s.name} ★12000 (+300)`,
        description: s.zh,
        url: `https://github.com/${s.name}`,
        // 刻意不带 picurl：项目没有仓库封面图，实测就是要看「无图卡片」长什么样
      })),
    },
  };
}

function markdownPayload(): Record<string, unknown> {
  return {
    msgtype: 'markdown',
    markdown: {
      content:
        '**【5/5 Markdown】**\n' +
        '> 引用块\n\n' +
        '- 列表项一\n' +
        '- 列表项二\n\n' +
        '[astral-sh/ruff](https://github.com/astral-sh/ruff)',
    },
  };
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
  const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
    { label: 'text', payload: textPayload() },
    { label: 'textcard', payload: textcardPayload() },
    { label: 'news-1', payload: newsPayload(1, '【3/5 图文1篇】') },
    { label: 'news-3', payload: newsPayload(3, '【4/5 图文3篇】') },
    { label: 'markdown', payload: markdownPayload() },
  ];

  const results: Array<{ type: string; ok: boolean; error?: string }> = [];
  for (const item of cases) {
    try {
      await postMessage(userid, { touser: userid, agentid, ...item.payload });
      results.push({ type: item.label, ok: true });
    } catch (err) {
      results.push({
        type: item.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 每条间隔 400ms：连着发容易被企微限频，也会让微信端消息堆在一起看不清
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ userid, results }, null, 2));
}
