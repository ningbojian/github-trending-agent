import type { EvalMetrics } from './metrics.js';
import { LOWER_IS_BETTER, MAX_REGRESSIONS, THRESHOLDS } from './thresholds.js';
import type { EvalResult, FailureRecord } from './types.js';

/** 浮点比较容差：指标都是比值，1e-9 足够区分「真的变了」。 */
const EPSILON = 1e-9;

/** 方向感知的比较：返回 1 = 变好，-1 = 变差，0 = 没变。 */
export function compareMetric(name: string, current: number, baseline: number): -1 | 0 | 1 {
  const delta = current - baseline;
  if (Math.abs(delta) <= EPSILON) return 0;
  const improvement = LOWER_IS_BETTER.has(name) ? delta < 0 : delta > 0;
  return improvement ? 1 : -1;
}

/** 与基线逐项比较，产出「回退」与「修复」列表（指标名）。 */
export function compareBaseline(
  current: EvalMetrics,
  baseline: EvalMetrics,
): { regressions: string[]; fixes: string[] } {
  const regressions: string[] = [];
  const fixes: string[] = [];
  for (const [name, value] of Object.entries(current)) {
    const previous = baseline[name];
    if (previous === undefined) continue;
    const direction = compareMetric(name, value, previous);
    if (direction === -1) regressions.push(name);
    if (direction === 1) fixes.push(name);
  }
  return { regressions, fixes };
}

/** 未达阈值（缺失的指标不检查——没跑就不该假通过）。 */
export function checkThresholds(metrics: EvalMetrics): string[] {
  const failures: string[] = [];
  for (const [name, minimum] of Object.entries(THRESHOLDS)) {
    const value = metrics[name];
    if (value === undefined) continue;
    const ok = LOWER_IS_BETTER.has(name) ? value <= minimum : value >= minimum;
    if (!ok) failures.push(`${name}=${format(value)}（要求 ${minimum}）`);
  }
  return failures;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function formatFailures(title: string, failures: FailureRecord[]): string[] {
  if (failures.length === 0) return [];
  const lines = [`${title}（${failures.length}）`];
  for (const failure of failures) {
    lines.push(`  · ${failure.id}｜${failure.text}`);
    lines.push(`    期望：${failure.expected}`);
    lines.push(`    实际：${failure.actual}`);
    if (failure.notes) lines.push(`    备注：${failure.notes}`);
  }
  return lines;
}

/** 人读报告：汇总表 → 阈值/基线 → 失败样例。 */
export function formatReport(result: EvalResult): string {
  const { metrics } = result;
  const lines: string[] = [];
  lines.push(`评测报告（${result.mode}）`);
  lines.push(`· 路由准确率：${format(metrics.route_accuracy ?? 1)}`);
  lines.push(`· 路由 macro-F1：${format(metrics.route_macro_f1 ?? 1)}`);
  lines.push(`· 解析 exact match：${format(metrics.parse_exact_match ?? 1)}`);
  lines.push(`· 规则覆盖率：${format(metrics.rule_coverage ?? 0)}`);
  lines.push(`· 规则误判率：${format(metrics.rule_false_positive_rate ?? 0)}`);
  lines.push(`· groundedness：${format(metrics.groundedness ?? 1)}`);
  lines.push(`· 运行时错误：${metrics.runtime_errors ?? 0}`);
  if (result.skippedTools > 0) {
    lines.push(`· 工具路由：跳过 ${result.skippedTools} 条（Phase 2 前无工具层）`);
  }
  if (result.mode === 'llm') {
    lines.push('· 模型评分：未接入（本次仍只跑确定性指标）');
  }

  if (result.thresholdFailures.length > 0) {
    lines.push('');
    lines.push(`阈值未通过（${result.thresholdFailures.length}）`);
    for (const failure of result.thresholdFailures) lines.push(`  · ${failure}`);
  } else {
    lines.push('· 阈值：全部通过');
  }

  if (result.regressions.length > 0) {
    lines.push(`· 基线：${result.regressions.length} 项回退 —— ${result.regressions.join('、')}`);
  } else if (result.fixes.length > 0) {
    lines.push(`· 基线：${result.fixes.length} 项改善 —— ${result.fixes.join('、')}`);
  }

  const details = [
    ...formatFailures('路由失败', result.routeFailures),
    ...formatFailures('解析失败', result.parseFailures),
    ...formatFailures('答案失败', result.answerFailures),
  ];
  if (details.length > 0) {
    lines.push('');
    lines.push(...details);
  }

  lines.push('');
  lines.push(result.ok ? '✅ 评测通过' : '❌ 评测未通过');
  return lines.join('\n');
}

/** 结果是否通过：阈值 + 回归条数都在门禁内。 */
export function isPassing(thresholdFailures: string[], regressions: string[]): boolean {
  return thresholdFailures.length === 0 && regressions.length <= MAX_REGRESSIONS;
}
