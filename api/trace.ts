import { desc, eq, like, sql, type SQL } from 'drizzle-orm';
import { env } from '../src/config.js';
import { db } from '../src/db/client.js';
import { agentRuns, kvCache } from '../src/db/schema.js';
import { escapeHtml, renderPage, sendHtml } from '../src/http/html.js';

/**
 * 运行日志页（只读）：回答「刚才那条消息走了哪条路、慢在哪一段」。
 *
 * 数据源有两个：
 * - `agent_runs` 是主路径：可按时间倒排、按用户过滤、交给 SQL 聚合。
 * - `kv_cache` 里的 `trace:` 是降级路径：迁移未执行或正式表写失败时写入，
 *   7 天 TTL。页面把两边合并展示，所以刚上线那段不会出现「记录凭空消失」。
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

/** 北京时间「MM-DD HH:MM:SS」：库里是 UTC，展示必须换时区。 */
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
  /** 排序用的时间戳；解析失败为 0（排在最后，但仍然展示）。 */
  at: number;
  time: string;
  kind: string;
  userid: string;
  text: string;
  totalMs: number;
  ok: boolean;
  steps: StepView[];
  /** 记录损坏（steps 不是数组）时为 true：照样列出，但不假装有内容。 */
  broken: boolean;
}

/** key = `trace:<ISO>-<随机后缀>`；解析失败返回 null。 */
function traceDate(key: string): Date | null {
  const rest = key.startsWith(TRACE_KEY_PREFIX)
    ? key.slice(TRACE_KEY_PREFIX.length)
    : key;
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(rest)?.[1];
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
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

/** 字段逐个兜底：一条坏记录不能把整页弄成 500。 */
function buildView(
  record: Record<string, unknown>,
  at: number,
  time: string,
): TraceView {
  const steps = toSteps(record.steps);
  return {
    at,
    time,
    kind: typeof record.kind === 'string' ? record.kind : '?',
    userid: typeof record.userid === 'string' ? record.userid : '?',
    text: typeof record.text === 'string' ? record.text : '',
    totalMs:
      typeof record.totalMs === 'number' && Number.isFinite(record.totalMs)
        ? record.totalMs
        : 0,
    ok: record.ok !== false,
    steps,
    broken: record.steps !== undefined && !Array.isArray(record.steps),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function toRunView(raw: unknown): TraceView {
  const record = asRecord(raw);
  const rawDate = record.createdAt;
  const date = rawDate instanceof Date ? rawDate : new Date(String(rawDate ?? ''));
  const at = Number.isNaN(date.getTime()) ? 0 : date.getTime();
  return buildView(record, at, at === 0 ? '?' : formatStamp(date));
}

function toKvView(key: string, value: unknown): TraceView {
  const date = traceDate(key);
  const at = date === null ? 0 : date.getTime();
  return buildView(asRecord(value), at, date === null ? key : formatStamp(date));
}

/** 主路径；表不存在/查询失败返回 null，由 kv 兜底。 */
async function readAgentRuns(
  userid: string,
  limit: number,
): Promise<TraceView[] | null> {
  try {
    const where: SQL = userid
      ? (eq(agentRuns.userid, userid) as SQL)
      : (sql`true` as SQL);
    const rows = await db()
      .select({
        id: agentRuns.id,
        kind: agentRuns.kind,
        userid: agentRuns.userid,
        text: agentRuns.text,
        totalMs: agentRuns.totalMs,
        ok: agentRuns.ok,
        steps: agentRuns.steps,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(where)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit);
    return rows.map(toRunView);
  } catch (err) {
    console.error('[trace] agent_runs query failed, falling back to kv_cache:', err);
    return null;
  }
}

/** 降级路径：迁移前写入的记录、以及正式表写失败时的那一份。 */
async function readKvTraces(
  userid: string,
  limit: number,
): Promise<TraceView[] | null> {
  try {
    const prefix = like(kvCache.key, `${TRACE_KEY_PREFIX}%`);
    const where: SQL = userid
      ? (sql`${prefix} and ${kvCache.value}->>'userid' = ${userid}` as SQL)
      : (prefix as SQL);
    const rows = await db()
      .select({ key: kvCache.key, value: kvCache.value })
      .from(kvCache)
      .where(where)
      .orderBy(desc(kvCache.key))
      .limit(limit);
    return rows.map((row) => toKvView(row.key, row.value));
  } catch (err) {
    console.error('[trace] kv_cache fallback query failed:', err);
    return null;
  }
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

  const [runs, kv] = await Promise.all([
    readAgentRuns(userid, limit),
    readKvTraces(userid, limit),
  ]);
  if (runs === null && kv === null) {
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

  // 两边各自已按时间倒排，合并后再排一次并截断到 n。
  const views = [...(runs ?? []), ...(kv ?? [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  const filterLine = userid
    ? `筛选用户：<b>${escapeHtml(userid)}</b>（去掉 <code>u</code> 参数看全部）`
    : `全部用户 · 按 <code>u=&lt;userid&gt;</code> 筛选单个人 · <code>n</code> 调整条数（上限 ${MAX_LIMIT}）`;

  const body = `<div style="font-size:13px;color:#57606a;margin:0 0 12px;">${filterLine}</div>
<div style="font-size:13px;color:#57606a;margin:0 0 12px;">共 ${views.length} 条 · 正式表 agent_runs + 缓存降级记录 · 保留 7 天 · 时间均为北京时间</div>
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
