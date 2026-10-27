import type { EvalMetrics } from './metrics.js';

/** 一条不达标的用例（报告里原样打印 id / 输入 / 期望 / 实际）。 */
export interface FailureRecord {
  id: string;
  text: string;
  expected: string;
  actual: string;
  notes?: string;
}

/** 一次完整评测的结果。runner 只负责产出它，不负责退出进程。 */
export interface EvalResult {
  mode: 'deterministic' | 'llm';
  metrics: EvalMetrics;
  routeFailures: FailureRecord[];
  parseFailures: FailureRecord[];
  answerFailures: FailureRecord[];
  /** tools.jsonl 里被跳过的条数（Phase 2 前恒为全部）。 */
  skippedTools: number;
  /** 相对基线的回退/修复（指标名 + 方向）。 */
  regressions: string[];
  fixes: string[];
  /** 未达阈值的指标名。 */
  thresholdFailures: string[];
  ok: boolean;
}
