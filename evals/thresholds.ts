/**
 * CI 门禁阈值。
 *
 * 只对「确定性、可复现」的指标设门槛：
 * - 路由与 groundedness 必须满分（错了就是用户在线上被回错话）；
 * - 解析允许 5% 误差（fallbackParse 是启发式，不是契约）；
 * - 规则误判必须为 0（错杀正常提问比漏判更伤）；
 * - 任何运行时错误、任何相对基线的回退都算失败。
 */
export const THRESHOLDS: Record<string, number> = {
  route_accuracy: 1,
  rule_false_positive_rate: 0,
  parse_exact_match: 0.95,
  tool_route_exact: 1,
  tool_arg_accuracy: 1,
  groundedness: 1,
  runtime_errors: 0,
};

/** 指标越大越好还是越小越好（默认越大越好）。 */
export const LOWER_IS_BETTER = new Set(['rule_false_positive_rate', 'runtime_errors']);

/** 允许的回归条数：0 —— 评测结果只能变好或不变。 */
export const MAX_REGRESSIONS = 0;
