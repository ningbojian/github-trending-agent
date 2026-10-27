import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeAnswer } from './adapters/answer.js';
import { observeParse } from './adapters/parse.js';
import { observeRoute } from './adapters/route.js';
import { observeToolRoute } from './adapters/tools.js';
import { loadGolden, REPO_ROOT, type LoadedCase } from './load.js';
import {
  computeMetrics,
  type AnswerSample,
  type EvalMetrics,
  type ParseSample,
  type RouteSample,
  type ToolSample,
} from './metrics.js';
import { checkThresholds, compareBaseline, isPassing } from './report.js';
import type { EvalResult, FailureRecord } from './types.js';

/** 确定性基线文件（入库；只允许手动 `--update-baseline` 覆盖）。 */
export const BASELINE_PATH = join(REPO_ROOT, 'evals', 'baselines', 'deterministic.json');

export interface RunEvalOptions {
  mode?: 'deterministic' | 'llm';
  /** 是否与基线比较（基线不存在时静默跳过）。 */
  compare?: boolean;
  baselinePath?: string;
  goldenDir?: string;
}

/** 基线文件形状；兼容只有 metrics 的对象与直接存 metrics 的对象。 */
export function readBaseline(path: string): EvalMetrics | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const metrics = record.metrics;
  if (typeof metrics === 'object' && metrics !== null) {
    return metrics as EvalMetrics;
  }
  const numeric = Object.entries(record).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
  return numeric.length > 0 ? Object.fromEntries(numeric) : null;
}

function shorten(value: unknown): string {
  return JSON.stringify(value);
}

function compareParse(
  item: LoadedCase,
  observation: Awaited<ReturnType<typeof observeParse>>,
): FailureRecord | null {
  const expected = item.expected.parse;
  if (expected === undefined) return null;
  const mismatches: string[] = [];
  const fields: Array<keyof typeof expected> = [
    'intent',
    'languages',
    'keywords',
    'period',
    'minStars',
    'sortBy',
    'topN',
  ];
  for (const field of fields) {
    const wanted = expected[field];
    if (wanted === undefined) continue;
    const actual =
      field === 'intent' ? observation.intent : observation.query[field];
    if (JSON.stringify(wanted) !== JSON.stringify(actual)) {
      mismatches.push(`${field}: 期望 ${shorten(wanted)} / 实际 ${shorten(actual)}`);
    }
  }
  if (mismatches.length === 0) return null;
  return {
    id: item.id,
    text: item.text,
    expected: shorten(expected),
    actual: mismatches.join('；'),
    notes: item.notes,
  };
}

/**
 * 跑一遍评测并汇总。**不调用 process.exit**——CLI 外壳负责退出码，
 * 测试可以把结果当普通返回值断言。
 */
export async function runEval(options: RunEvalOptions = {}): Promise<EvalResult> {
  const mode = options.mode ?? 'deterministic';
  const cases = loadGolden(options.goldenDir);

  const routes: RouteSample[] = [];
  const parses: ParseSample[] = [];
  const answers: AnswerSample[] = [];
  const tools: ToolSample[] = [];
  const routeFailures: FailureRecord[] = [];
  const parseFailures: FailureRecord[] = [];
  const answerFailures: FailureRecord[] = [];
  const toolFailures: FailureRecord[] = [];
  let skippedTools = 0;

  for (const item of cases) {
    // ---- 路由 ----
    if (item.expected.route !== undefined) {
      try {
        const observation = observeRoute(item.text);
        const expectedLabel = `${item.expected.route.kind}:${item.expected.route.name}`;
        routes.push({ id: item.id, expected: expectedLabel, actual: observation.label });
        if (observation.label !== expectedLabel) {
          routeFailures.push({
            id: item.id,
            text: item.text,
            expected: expectedLabel,
            actual: observation.label,
            notes: item.notes,
          });
        }
      } catch (err) {
        routes.push({ id: item.id, expected: 'handler:search', actual: 'error' });
        routeFailures.push({
          id: item.id,
          text: item.text,
          expected: `${item.expected.route.kind}:${item.expected.route.name}`,
          actual: `运行时错误：${err instanceof Error ? err.message : String(err)}`,
          notes: item.notes,
        });
      }
    }

    // ---- 解析 ----
    if (item.expected.parse !== undefined) {
      try {
        const observation = await observeParse(item.text);
        parses.push({ id: item.id, expected: item.expected.parse, observation });
        const failure = compareParse(item, observation);
        if (failure !== null) parseFailures.push(failure);
      } catch (err) {
        parseFailures.push({
          id: item.id,
          text: item.text,
          expected: shorten(item.expected.parse),
          actual: `运行时错误：${err instanceof Error ? err.message : String(err)}`,
          notes: item.notes,
        });
      }
    }

    // ---- 答案（fixture 排版） ----
    if (item.expected.answer !== undefined) {
      try {
        const observation = observeAnswer(item.expected.answer);
        answers.push({ id: item.id, observation });
        if (observation.ungrounded.length > 0 || observation.missing.length > 0) {
          answerFailures.push({
            id: item.id,
            text: item.text,
            expected: `grounded；必须出现：${(item.expected.answer.mustMention ?? []).join('、') || '无'}`,
            actual:
              `未在结果集中：${observation.ungrounded.join('、') || '无'}；` +
              `未出现：${observation.missing.join('、') || '无'}`,
            notes: item.notes,
          });
        }
      } catch (err) {
        answerFailures.push({
          id: item.id,
          text: item.text,
          expected: 'grounded 回复',
          actual: `运行时错误：${err instanceof Error ? err.message : String(err)}`,
          notes: item.notes,
        });
      }
    }

    // ---- 工具路由（规则前置；不需要模型/网络） ----
    if (item.expected.tools !== undefined) {
      const expected = item.expected.tools;
      try {
        const observation = observeToolRoute(item.text);
        tools.push({ id: item.id, expected, observation });
        if (observation.skipped) skippedTools += 1;

        const routeOk = observation.route === expected.route;
        const toolOk = expected.tool === undefined || observation.tool === expected.tool;
        const argsOk =
          expected.args?.repo === undefined ||
          (observation.args?.repo ?? null) === expected.args.repo;
        if (!routeOk || !toolOk || !argsOk) {
          toolFailures.push({
            id: item.id,
            text: item.text,
            expected:
              `${expected.route}${expected.tool === undefined ? '' : `/${expected.tool}`}` +
              `${expected.args?.repo === undefined ? '' : ` repo=${expected.args.repo}`}`,
            actual:
              `${observation.route ?? 'skipped'}${observation.tool === undefined ? '' : `/${observation.tool}`}` +
              `${observation.args?.repo == null ? '' : ` repo=${observation.args.repo}`}`,
            notes: item.notes,
          });
        }
      } catch (err) {
        toolFailures.push({
          id: item.id,
          text: item.text,
          expected: `${expected.route}${expected.tool === undefined ? '' : `/${expected.tool}`}`,
          actual: `运行时错误：${err instanceof Error ? err.message : String(err)}`,
          notes: item.notes,
        });
      }
    }
  }

  const runtimeErrors =
    [...routeFailures, ...parseFailures, ...answerFailures, ...toolFailures].filter((f) =>
      f.actual.includes('运行时错误'),
    ).length;

  const metrics = computeMetrics({ routes, parses, answers, tools, runtimeErrors });
  const thresholdFailures = checkThresholds(metrics);

  const baseline = options.compare === true
    ? readBaseline(options.baselinePath ?? BASELINE_PATH)
    : null;
  const { regressions, fixes } =
    baseline === null
      ? { regressions: [], fixes: [] }
      : compareBaseline(metrics, baseline);

  return {
    mode,
    metrics,
    routeFailures,
    parseFailures,
    answerFailures,
    toolFailures,
    skippedTools,
    regressions,
    fixes,
    thresholdFailures,
    ok: isPassing(thresholdFailures, regressions),
  };
}
