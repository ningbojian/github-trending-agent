import type { ParseObservation } from './adapters/parse.js';
import type { AnswerObservation } from './adapters/answer.js';
import type { ParseExpectation } from './schema.js';

/**
 * 评测指标（全部纯函数，无 I/O）。
 *
 * 只看确定性指标：路由、解析字段、groundedness、运行时错误。
 * 「答案好不好」需要模型评分，走 --llm，不进 CI。
 */

export interface RouteSample {
  id: string;
  expected: string;
  actual: string;
}

export interface ParseSample {
  id: string;
  expected: ParseExpectation;
  observation: ParseObservation;
}

export interface AnswerSample {
  id: string;
  observation: AnswerObservation;
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function routeAccuracy(samples: RouteSample[]): number {
  return ratio(
    samples.filter((sample) => sample.expected === sample.actual).length,
    samples.length,
  );
}

/** 混淆矩阵：expected → actual → 次数。 */
export function confusionMatrix(
  samples: RouteSample[],
): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const sample of samples) {
    const row = (matrix[sample.expected] ??= {});
    row[sample.actual] = (row[sample.actual] ?? 0) + 1;
  }
  return matrix;
}

/** 每个标签的 precision/recall/F1，再对标签取算术平均（macro）。 */
export function macroF1(samples: RouteSample[]): number {
  const labels = [...new Set(samples.flatMap((sample) => [sample.expected, sample.actual]))];
  if (labels.length === 0) return 1;
  const scores = labels.map((label) => {
    const tp = samples.filter((s) => s.expected === label && s.actual === label).length;
    const fp = samples.filter((s) => s.expected !== label && s.actual === label).length;
    const fn = samples.filter((s) => s.expected === label && s.actual !== label).length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return f1;
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/** 规则层出了结论的比例（规则越敢判，越多输入不用花 token）。 */
export function ruleCoverage(samples: ParseSample[]): number {
  return ratio(
    samples.filter((sample) => sample.observation.ruleIntent !== null).length,
    samples.length,
  );
}

/** 规则层有结论、但结论与金标相悖的比例（错杀正常提问的代价）。 */
export function ruleFalsePositiveRate(samples: ParseSample[]): number {
  const judged = samples.filter(
    (sample) =>
      sample.observation.ruleIntent !== null && sample.expected.intent !== undefined,
  );
  // 规则没有下过结论 → 不存在误判。这里不能沿用 ratio 的空分母 = 1（那是准确率语义），
  // 否则「本批样本没写 intent」会被当成 100% 误判。
  if (judged.length === 0) return 0;
  const wrong = judged.filter(
    (sample) => sample.observation.ruleIntent !== sample.expected.intent,
  );
  return ratio(wrong.length, judged.length);
}

/** 规则拿不准、最终由 fallbackParse 接住的比例（解析降级比例）。 */
export function fallbackParseCoverage(samples: ParseSample[]): number {
  return ratio(
    samples.filter((sample) => sample.observation.ruleIntent === null).length,
    samples.length,
  );
}

const PARSE_FIELDS: Array<keyof ParseExpectation> = [
  'intent',
  'languages',
  'keywords',
  'period',
  'minStars',
  'sortBy',
  'topN',
];

function actualField(
  observation: ParseObservation,
  field: keyof ParseExpectation,
): unknown {
  if (field === 'intent') return observation.intent;
  // SearchQuery 与 ParseExpectation 的槽位同名但不是同一个类型，索引要放宽。
  return (observation.query as unknown as Record<string, unknown>)[field];
}

function fieldMatches(
  field: keyof ParseExpectation,
  expected: unknown,
  observation: ParseObservation,
): boolean {
  const actual = actualField(observation, field);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => item === actual[index])
    );
  }
  return expected === actual;
}

/** 写了哪些字段就比哪些；全部命中才算这条 exact match。 */
export function parseExactMatch(samples: ParseSample[]): number {
  return ratio(
    samples.filter((sample) =>
      PARSE_FIELDS.every((field) => {
        const expected = sample.expected[field];
        if (expected === undefined) return true;
        return fieldMatches(field, expected, sample.observation);
      }),
    ).length,
    samples.length,
  );
}

/** 逐字段准确率：分母只算写了该字段的用例。 */
export function parseFieldAccuracy(samples: ParseSample[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const field of PARSE_FIELDS) {
    const judged = samples.filter((sample) => sample.expected[field] !== undefined);
    if (judged.length === 0) continue;
    result[field] = ratio(
      judged.filter((sample) =>
        fieldMatches(field, sample.expected[field], sample.observation),
      ).length,
      judged.length,
    );
  }
  return result;
}

/** 每条回复的仓库都来自结果集、且必须出现的都出现 → 算 grounded。 */
export function groundedness(samples: AnswerSample[]): number {
  return ratio(
    samples.filter(
      (sample) =>
        sample.observation.ungrounded.length === 0 &&
        sample.observation.missing.length === 0,
    ).length,
    samples.length,
  );
}

export interface EvalMetrics {
  [name: string]: number;
}

export interface MetricInputs {
  routes: RouteSample[];
  parses: ParseSample[];
  answers: AnswerSample[];
  runtimeErrors: number;
}

export function computeMetrics(inputs: MetricInputs): EvalMetrics {
  return {
    route_accuracy: routeAccuracy(inputs.routes),
    route_macro_f1: macroF1(inputs.routes),
    rule_coverage: ruleCoverage(inputs.parses),
    rule_false_positive_rate: ruleFalsePositiveRate(inputs.parses),
    parse_exact_match: parseExactMatch(inputs.parses),
    fallback_parse_coverage: fallbackParseCoverage(inputs.parses),
    groundedness: groundedness(inputs.answers),
    runtime_errors: inputs.runtimeErrors,
    ...Object.fromEntries(
      Object.entries(parseFieldAccuracy(inputs.parses)).map(([field, value]) => [
        `parse_field_${field}`,
        value,
      ]),
    ),
  };
}
