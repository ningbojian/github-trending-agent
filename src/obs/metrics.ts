import { createHash } from 'node:crypto';

/**
 * 度量看板的纯函数层：不碰数据库、不读 env。
 *
 * 输入是已经按时间窗取好的行，输出是可直接 JSON 化的摘要。这样：
 * - 口径（分位、按天、去重）可以被单测钉死，不依赖线上数据；
 * - `api/metrics.ts` 只负责鉴权、取数与渲染。
 *
 * 隐私：对外只给 userid 的哈希，且只给「有多少人」，不给名单。
 */

export const METRICS_DEFAULT_DAYS = 7;
export const METRICS_MAX_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetricsRunInput {
  createdAt: Date | string;
  kind: string;
  userid: string;
  ok: boolean;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  steps: unknown;
}

export interface MetricsToolInput {
  createdAt: Date | string;
  tool: string;
  status: string;
  latencyMs: number;
}

export interface DayBucket {
  day: string;
  total: number;
  ok: number;
  failed: number;
}

export interface CountRow {
  name: string;
  count: number;
}

export interface ToolRow {
  tool: string;
  count: number;
  errors: number;
  latencyMs: { p50: number; p95: number };
}

export interface MetricsSummary {
  generatedAt: string;
  windowDays: number;
  runs: {
    total: number;
    okRate: number | null;
    latencyMs: { p50: number; p95: number } | null;
    byKind: { text: number; event: number; push: number; other: number };
    perDay: DayBucket[];
    distinctUsers: number;
    tokens: { input: number; output: number };
  };
  routes: CountRow[];
  parseSources: CountRow[];
  tools: {
    total: number;
    errorRate: number | null;
    byTool: ToolRow[];
  };
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 北京时间日期（YYYY-MM-DD）：凌晨的消息不能算到前一天。 */
export function beijingDay(date: Date): string {
  const parts = dayFormatter.formatToParts(date);
  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** nearest-rank 分位；空样本返回 0，由调用方决定是否展示为 N/A。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** 对外只暴露 8 位哈希：既能数人数，又拼不回 userid。 */
export function hashUserid(userid: string): string {
  return createHash('sha1').update(userid).digest('hex').slice(0, 8);
}

/** `?days=`：默认 7，非法回落默认，上限 30（防止一次把库拖垮）。 */
export function resolveDays(raw: unknown): number {
  const text = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return METRICS_DEFAULT_DAYS;
  }
  return Math.min(parsed, METRICS_MAX_DAYS);
}

export function metricsSince(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function toDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countSteps(steps: unknown, name: string): string[] {
  if (!Array.isArray(steps)) {
    return [];
  }
  const details: string[] = [];
  for (const item of steps) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const step = item as Record<string, unknown>;
    if (step.name === name && typeof step.detail === 'string' && step.detail !== '') {
      details.push(step.detail);
    }
  }
  return details;
}

function toCountRows(counter: Map<string, number>): CountRow[] {
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function summarizeMetrics(
  runs: MetricsRunInput[],
  tools: MetricsToolInput[],
  options: { now: Date; days: number },
): MetricsSummary {
  const { now, days } = options;

  // 窗口内的每一天都先建桶：没有消息的那天显示 0，而不是从图里消失。
  const perDay: DayBucket[] = [];
  const buckets = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const bucket: DayBucket = {
      day: beijingDay(new Date(now.getTime() - i * DAY_MS)),
      total: 0,
      ok: 0,
      failed: 0,
    };
    perDay.push(bucket);
    buckets.set(bucket.day, bucket);
  }

  const byKind = { text: 0, event: 0, push: 0, other: 0 };
  const latencies: number[] = [];
  const users = new Set<string>();
  const routeCounter = new Map<string, number>();
  const parseCounter = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let okCount = 0;
  let runCount = 0;

  for (const run of runs) {
    const date = toDate(run.createdAt);
    if (date === null) {
      continue;
    }
    const bucket = buckets.get(beijingDay(date));
    if (bucket === undefined) {
      continue;
    }
    runCount += 1;
    bucket.total += 1;
    if (run.ok) {
      bucket.ok += 1;
      okCount += 1;
    } else {
      bucket.failed += 1;
    }

    if (run.kind === 'text' || run.kind === 'event' || run.kind === 'push') {
      byKind[run.kind] += 1;
    } else {
      byKind.other += 1;
    }

    const latency = finite(run.totalMs);
    if (latency !== null && latency >= 0) {
      latencies.push(latency);
    }
    const input = finite(run.inputTokens);
    const output = finite(run.outputTokens);
    if (input !== null && input > 0) {
      inputTokens += input;
    }
    if (output !== null && output > 0) {
      outputTokens += output;
    }

    if (typeof run.userid === 'string' && run.userid !== '') {
      users.add(hashUserid(run.userid));
    }

    for (const detail of countSteps(run.steps, 'handler')) {
      routeCounter.set(detail, (routeCounter.get(detail) ?? 0) + 1);
    }
    for (const detail of countSteps(run.steps, 'parse-source')) {
      parseCounter.set(detail, (parseCounter.get(detail) ?? 0) + 1);
    }
  }

  const toolGroups = new Map<string, { count: number; errors: number; latencies: number[] }>();
  let toolErrors = 0;
  for (const call of tools) {
    const group = toolGroups.get(call.tool) ?? { count: 0, errors: 0, latencies: [] };
    group.count += 1;
    if (call.status === 'error') {
      group.errors += 1;
      toolErrors += 1;
    }
    const latency = finite(call.latencyMs);
    if (latency !== null && latency >= 0) {
      group.latencies.push(latency);
    }
    toolGroups.set(call.tool, group);
  }

  const byTool: ToolRow[] = [...toolGroups.entries()]
    .map(([tool, group]) => ({
      tool,
      count: group.count,
      errors: group.errors,
      latencyMs: {
        p50: Math.round(percentile(group.latencies, 50)),
        p95: Math.round(percentile(group.latencies, 95)),
      },
    }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    runs: {
      total: runCount,
      okRate: runCount === 0 ? null : okCount / runCount,
      latencyMs:
        latencies.length === 0
          ? null
          : {
              p50: Math.round(percentile(latencies, 50)),
              p95: Math.round(percentile(latencies, 95)),
            },
      byKind,
      perDay,
      distinctUsers: users.size,
      tokens: { input: inputTokens, output: outputTokens },
    },
    routes: toCountRows(routeCounter),
    parseSources: toCountRows(parseCounter),
    tools: {
      total: tools.length,
      errorRate: tools.length === 0 ? null : toolErrors / tools.length,
      byTool,
    },
  };
}
