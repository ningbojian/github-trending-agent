import { gte } from 'drizzle-orm';
import { env } from '../src/config.js';
import { db } from '../src/db/client.js';
import { agentRuns, toolCalls } from '../src/db/schema.js';
import { escapeHtml, renderPage, sendHtml } from '../src/http/html.js';
import {
  metricsSince,
  resolveDays,
  summarizeMetrics,
  type MetricsSummary,
} from '../src/obs/metrics.js';

/**
 * 度量看板（只读）：把「有多少消息、成功率多少、慢在哪、路由怎么分、
 * 模型用了多少 token」变成能报出来的数字。
 *
 * 口径在 `src/obs/metrics.ts`（纯函数、可单测）；这里只做鉴权、取数、渲染。
 *
 * 鉴权复用 CRON_SECRET（`?secret=` 或 `Authorization: Bearer`）——与推送、
 * 运行日志同一把钥匙，不新增环境变量。失败一律 401，不泄露任何记录。
 *
 * 迁移 0004 未执行时明确回 503 + 提示，而不是输出一份全 0 的假数据：
 * 「今天没有流量」和「表根本没建」在排障时是完全相反的两个结论。
 */

export interface MetricsRequest {  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

export interface MetricsResponse {
  status(code: number): MetricsResponse;
  setHeader(name: string, value: string): MetricsResponse | void;
  send(body: string): unknown;
}

function queryParam(req: MetricsRequest, name: string): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function bearerToken(req: MetricsRequest): string {
  const raw = req.headers?.['authorization'];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function latency(pair: { p50: number; p95: number } | null): string {
  return pair === null ? '—' : `${pair.p50} / ${pair.p95} ms`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return '<p style="font-size:13px;color:#57606a;">窗口内没有数据。</p>';
  }
  const head = headers
    .map(
      (cell) =>
        `<th style="text-align:left;padding:4px 10px 4px 0;color:#57606a;font-weight:600;">${escapeHtml(cell)}</th>`,
    )
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell) =>
              `<td style="padding:3px 10px 3px 0;white-space:nowrap;">${escapeHtml(cell)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<table style="border-collapse:collapse;font-size:13px;margin:0 0 16px;">
  <thead><tr>${head}</tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

function renderMetrics(summary: MetricsSummary): string {
  const runs = summary.runs;
  const tiles: Array<[string, string]> = [
    ['消息 / 推送总数', String(runs.total)],
    ['成功率', percent(runs.okRate)],
    ['耗时 p50 / p95', latency(runs.latencyMs)],
    ['独立用户（哈希去重）', String(runs.distinctUsers)],
    ['输入 token', String(runs.tokens.input)],
    ['输出 token', String(runs.tokens.output)],
    ['工具调用', String(summary.tools.total)],
    ['工具错误率', percent(summary.tools.errorRate)],
  ];
  const tileHtml = tiles
    .map(
      ([label, value]) =>
        `<div style="border:1px solid #d0d7de;border-radius:8px;padding:8px 12px;min-width:150px;">
  <div style="font-size:12px;color:#57606a;">${escapeHtml(label)}</div>
  <div style="font-size:20px;font-weight:700;">${escapeHtml(value)}</div>
</div>`,
    )
    .join('');

  const dayRows = runs.perDay.map((day) => [day.day, String(day.total), String(day.ok), String(day.failed)]);
  const routeRows = summary.routes.map((row) => [row.name, String(row.count)]);
  const parseRows = summary.parseSources.map((row) => [row.name, String(row.count)]);
  const toolRows = summary.tools.byTool.map((row) => [
    row.tool,
    String(row.count),
    String(row.errors),
    `${row.latencyMs.p50} / ${row.latencyMs.p95} ms`,
  ]);

  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;">${tileHtml}</div>
<div style="font-size:12px;color:#57606a;margin:0 0 12px;">窗口：最近 ${summary.windowDays} 天 · 生成于 ${escapeHtml(summary.generatedAt)} · 时间为北京时间</div>
<h3 style="font-size:15px;margin:16px 0 8px;">按天</h3>
${table(['日期', '总数', '成功', '失败'], dayRows)}
<h3 style="font-size:15px;margin:16px 0 8px;">路由分布</h3>
${table(['处理器', '次数'], routeRows)}
<h3 style="font-size:15px;margin:16px 0 8px;">解析来源</h3>
${table(['来源', '次数'], parseRows)}
<h3 style="font-size:15px;margin:16px 0 8px;">工具</h3>
${table(['工具', '次数', '错误', 'p50 / p95'], toolRows)}`;
}

export default async function handler(
  req: MetricsRequest,
  res: MetricsResponse,
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

  const format = queryParam(req, 'format');
  const html = format === 'html';
  const days = resolveDays(queryParam(req, 'days'));
  const now = new Date();
  const since = metricsSince(now, days);

  let summary: MetricsSummary;
  try {
    const runs = await db()
      .select({
        createdAt: agentRuns.createdAt,
        kind: agentRuns.kind,
        userid: agentRuns.userid,
        ok: agentRuns.ok,
        totalMs: agentRuns.totalMs,
        inputTokens: agentRuns.inputTokens,
        outputTokens: agentRuns.outputTokens,
        steps: agentRuns.steps,
      })
      .from(agentRuns)
      .where(gte(agentRuns.createdAt, since));
    const calls = await db()
      .select({
        createdAt: toolCalls.createdAt,
        tool: toolCalls.tool,
        status: toolCalls.status,
        latencyMs: toolCalls.latencyMs,
      })
      .from(toolCalls)
      .where(gte(toolCalls.createdAt, since));
    summary = summarizeMetrics(runs, calls, { now, days });
  } catch (err) {
    console.error('[metrics] query failed:', err);
    const hint = 'agent_runs / tool_calls 可能还不存在：先执行 npm run db:migrate（迁移 0004）。';
    if (html) {
      sendHtml(
        res,
        503,
        renderPage({
          title: '度量看板',
          subtitle: '暂时不可用',
          body: `<p style="font-size:14px;">${escapeHtml(hint)}</p>`,
        }),
      );
      return;
    }
    res.status(503).setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ error: 'metrics-unavailable', hint }, null, 2));
    return;
  }

  if (html) {
    sendHtml(
      res,
      200,
      renderPage({
        title: '度量看板',
        subtitle: `最近 ${days} 天`,
        body: renderMetrics(summary),
      }),
    );
    return;
  }

  res.status(200).setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(summary, null, 2));
}
