import { and, desc, like, sql, type SQL } from 'drizzle-orm';
import { env } from '../src/config.js';
import { db } from '../src/db/client.js';
import { kvCache } from '../src/db/schema.js';
import { escapeHtml, renderPage, sendHtml } from '../src/http/html.js';

/**
 * 运行日志页（只读）：把 src/obs/trace.ts 落进 kv_cache 的 trace 记录渲染出来，
 * 用来回答「刚才那条消息到底走了哪条路、慢在哪一段」。
 *
 * 设计取舍：
 * - 服务端渲染、不依赖前端 JS：手机上直接开链接就能看。
 * - 不用 @vercel/node 类型：沿用 api/cron-push-digest.ts 的最小 req/res 形态。
 * - 鉴权复用 CRON_SECRET（`?secret=` 或 `Authorization: Bearer`）：与推送端点同一把钥匙，
 *   不新增环境变量；失败一律 401，不泄露任何记录。
 * - 全部动态文本经 escapeHtml：trace 里存的是用户原话，绝不能让 <script> 落地。
 */

const TRACE_KEY_PREFIX = 'trace:';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface TraceRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

export interface TraceResponse {
  status(code: number): TraceResponse;
  setHeader(name: string, value: string): TraceResponse | void;
  send(body: string): unknown;
}

/** 北京时间「MM-DD HH:MM:SS」：trace 的 key 里是 UTC ISO，展示必须换时区。 */
const stampFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function formatStamp(date: Date): string {
  const parts = stampFormatter.formatToParts(date);
  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function queryParam(
  req: TraceRequest,
  name: string,
): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function bearerToken(req: TraceRequest): string {
  const raw = req.headers?.['authorization'];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
}

/** n 参数：默认 50，上限 200，非正整数回落默认。 */
function resolveLimit(req: TraceRequest): number {
  const parsed = Number(queryParam(req, 'n'));
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

interface StepView {
  ms: number;
  name: string;
  detail: string;
}

interface TraceView {
  time: string;
  kind: string;
  userid: string;
  text: string;
  totalMs: number;
  ok: boolean;
  steps: StepView[];
  /** 记录损坏（value 不是预期形状）时为 true：照样列出，但不假装有内容。 */
  broken: boolean;
}

/** key = `trace:<ISO>-<随机后缀>`；解析失败就原样显示。 */
function traceTime(key: string): string {
  const rest = key.startsWith(TRACE_KEY_PREFIX)
    ? key.slice(TRACE_KEY_PREFIX.length)
    : key;
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(rest)?.[1];
  if (!iso) {
    return rest;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? rest : formatStamp(date);
}

function toSteps(raw: unknown): StepView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => {
    const step = (typeof item === 'object' && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    return {
      ms: typeof step.ms === 'number' && Number.isFinite(step.ms) ? step.ms : 0,
      name: typeof step.name === 'string' ? step.name : '?',
      detail: typeof step.detail === 'string' ? step.detail : '',
    };
  });
}

/** 把一行 kv_cache 解析成视图模型；脏数据降级而不是抛错（页面不能因为一条坏记录变空白）。 */
function toView(key: string, value: unknown): TraceView {
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const steps = toSteps(record.steps);
  return {
    time: traceTime(key),
    kind: typeof record.kind === 'string' ? record.kind : '?',
    userid: typeof record.userid === 'string' ? record.userid : '?',
    text: typeof record.text === 'string' ? record.text : '',
    totalMs:
      typeof record.totalMs === 'number' && Number.isFinite(record.totalMs)
        ? record.totalMs
        : 0,
    ok: record.ok !== false,
    steps,
    broken: steps.length === 0 && record.steps !== undefined,
  };
}

function renderTrace(view: TraceView): string {
  const c = {
    cardBorder: '#d0d7de',
    muted: '#57606a',
    badge: view.ok ? '#1a7f37' : '#cf222e',
  };
  const summary = [
    `<span style="color:${c.badge};font-weight:700;">${view.ok ? '✓' : '✗'}</span>`,
    `<span style="color:${c.muted};">${escapeHtml(view.time)}</span>`,
    `<b>${escapeHtml(view.userid)}</b>`,
    `<span style="color:${c.muted};">${escapeHtml(view.kind)}</span>`,
    `<span style="color:${c.muted};">${view.totalMs} ms</span>`,
  ].join(' · ');

  const stepsRow = view.steps
    .map(
      (step) =>
        `<tr><td style="padding:2px 8px 2px 0;color:${c.muted};text-align:right;white-space:nowrap;">${step.ms}ms</td>` +
        `<td style="padding:2px 8px 2px 0;white-space:nowrap;">${escapeHtml(step.name)}</td>` +
        `<td style="padding:2px 0;color:${c.muted};word-break:break-all;">${escapeHtml(step.detail)}</td></tr>`,
    )
    .join('');

  const table =
    view.steps.length === 0
      ? `<div style="color:${c.muted};font-size:13px;">${
          view.broken ? '这条记录的形状不对（可能是旧版本写入）。' : '没有任何步骤。'
        }</div>`
      : `<table style="width:100%;border-collapse:collapse;font-size:13px;font-family:ui-monospace,Consolas,monospace;">${stepsRow}</table>`;

  return `<details style="border:1px solid ${c.cardBorder};border-radius:8px;padding:8px 10px;margin:0 0 8px;">
  <summary style="cursor:pointer;font-size:13px;line-height:1.7;">${summary}</summary>
  <div style="margin:8px 0 4px;font-size:13px;word-break:break-all;">${escapeHtml(view.text)}</div>
  ${table}
</details>`;
}

export default async function handler(
  req: TraceRequest,
  res: TraceResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    res.status(405).send('method not allowed');
    return;
  }

  const expected = env.CRON_SECRET ?? '';
  const provided = queryParam(req, 'secret') || bearerToken(req);
  if (expected === '' || provided !== expected) {
    res.status(401).send('unauthorized');
    return;
  }

  const userid = queryParam(req, 'u').trim();
  const limit = resolveLimit(req);

  let views: TraceView[];
  try {
    const prefix = like(kvCache.key, `${TRACE_KEY_PREFIX}%`);
    const where: SQL = userid
      ? (and(prefix, sql`${kvCache.value}->>'userid' = ${userid}`) as SQL)
      : (prefix as SQL);
    const rows = await db()
      .select({ key: kvCache.key, value: kvCache.value })
      .from(kvCache)
      .where(where)
      .orderBy(desc(kvCache.key))
      .limit(limit);
    views = rows.map((row) => toView(row.key, row.value));
  } catch (err) {
    console.error('[trace] query failed:', err);
    sendHtml(
      res,
      500,
      renderPage({
        title: '运行日志',
        subtitle: '读取失败',
        body: `<p style="font-size:14px;">查询 trace 记录时出错，请稍后重试。</p>`,
      }),
    );
    return;
  }

  const filterLine = userid
    ? `筛选用户：<b>${escapeHtml(userid)}</b>（去掉 <code>u</code> 参数看全部）`
    : `全部用户 · 按 <code>u=&lt;userid&gt;</code> 筛选单个人 · <code>n</code> 调整条数（上限 ${MAX_LIMIT}）`;

  const body = `<div style="font-size:13px;color:#57606a;margin:0 0 12px;">${filterLine}</div>
<div style="font-size:13px;color:#57606a;margin:0 0 12px;">共 ${views.length} 条 · 保留 7 天 · 时间均为北京时间</div>
${
  views.length === 0
    ? '<p style="font-size:14px;">暂无记录。发一条消息给 Agent，几秒后刷新本页。</p>'
    : views.map(renderTrace).join('\n')
}`;

  sendHtml(
    res,
    200,
    renderPage({ title: '运行日志', subtitle: '每条消息走了哪条路', body }),
  );
}
