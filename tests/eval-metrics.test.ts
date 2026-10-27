import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  confusionMatrix,
  groundedness,
  macroF1,
  parseExactMatch,
  parseFieldAccuracy,
  ratio,
  routeAccuracy,
  ruleCoverage,
  ruleFalsePositiveRate,
} from '../evals/metrics';
import type { AnswerObservation } from '../evals/adapters/answer';
import type { ParseObservation } from '../evals/adapters/parse';
import { compareBaseline, compareMetric, checkThresholds } from '../evals/report';
import type { ParseExpectation } from '../evals/schema';
import type { ParseSample } from '../evals/metrics';

function parseSample(
  expected: ParseExpectation,
  query: Partial<ParseObservation['query']> = {},
  ruleIntent: ParseObservation['ruleIntent'] = null,
): ParseSample {
  const full = {
    intent: 'search' as const,
    languages: [] as string[],
    keywords: [] as string[],
    period: 'week' as const,
    minStars: null,
    sortBy: 'stars_delta' as const,
    topN: 10,
    ...query,
  };
  return {
    id: 'sample',
    expected,
    observation: {
      ruleIntent,
      query: full,
      intent: ruleIntent ?? full.intent,
    },
  };
}

function answer(ungrounded: string[], missing: string[]): AnswerObservation {
  return { text: '', mentioned: [], ungrounded, missing };
}

describe('eval metrics — 路由', () => {
  it('空样本按 1 处理（没跑不算失败）', () => {
    expect(ratio(0, 0)).toBe(1);
    expect(routeAccuracy([])).toBe(1);
  });

  it('准确率只数 expected === actual', () => {
    expect(
      routeAccuracy([
        { id: 'a', expected: 'handler:help', actual: 'handler:help' },
        { id: 'b', expected: 'handler:search', actual: 'handler:favorite' },
      ]),
    ).toBe(0.5);
  });

  it('混淆矩阵按 expected → actual 计数', () => {
    expect(
      confusionMatrix([
        { id: 'a', expected: 'handler:help', actual: 'handler:help' },
        { id: 'b', expected: 'handler:search', actual: 'handler:favorite' },
      ]),
    ).toEqual({
      'handler:help': { 'handler:help': 1 },
      'handler:search': { 'handler:favorite': 1 },
    });
  });

  it('macro-F1 对完全正确的样本为 1', () => {
    expect(
      macroF1([{ id: 'a', expected: 'handler:help', actual: 'handler:help' }]),
    ).toBe(1);
  });

  it('macro-F1 惩罚把两类的样本混成一类', () => {
    const score = macroF1([
      { id: 'a', expected: 'handler:help', actual: 'handler:help' },
      { id: 'b', expected: 'handler:search', actual: 'handler:help' },
      { id: 'c', expected: 'handler:search', actual: 'handler:help' },
    ]);
    expect(score).toBeLessThan(0.5);
  });
});

describe('eval metrics — 解析', () => {
  it('规则覆盖率 = 规则层有结论的占比', () => {
    expect(
      ruleCoverage([
        parseSample({}, {}, 'about'),
        parseSample({}, {}, null),
      ]),
    ).toBe(0.5);
  });

  it('规则误判率只看规则有结论且有金标的样本', () => {
    expect(
      ruleFalsePositiveRate([
        parseSample({ intent: 'about' }, {}, 'about'),
        parseSample({ intent: 'search' }, {}, 'off_topic'),
      ]),
    ).toBe(0.5);
  });

  it('没写 intent 的样本不参与规则误判统计（空分母按 0 计）', () => {
    expect(
      ruleFalsePositiveRate([parseSample({ keywords: ['ai'] }, {}, 'off_topic')]),
    ).toBe(0);
  });

  it('exact match 只比较写出来的字段', () => {
    const score = parseExactMatch([
      parseSample({ languages: ['python'] }, { languages: ['python'] }),
      parseSample({ keywords: ['ai'] }, { keywords: ['rust'] }),
    ]);
    expect(score).toBe(0.5);
  });

  it('数组字段顺序不同视为不匹配', () => {
    expect(
      parseExactMatch([
        parseSample(
          { languages: ['python', 'rust'] },
          { languages: ['rust', 'python'] },
        ),
      ]),
    ).toBe(0);
  });

  it('逐字段准确率的分母只算写了该字段的样本', () => {
    const accuracy = parseFieldAccuracy([
      parseSample({ topN: 5 }, { topN: 5 }),
      parseSample({ topN: 10 }, { topN: 10 }),
      parseSample({ languages: ['go'] }, { languages: ['go'] }),
    ]);
    expect(accuracy.topN).toBe(1);
    expect(accuracy.languages).toBe(1);
    expect(accuracy.keywords).toBeUndefined();
  });
});

describe('eval metrics — groundedness 与汇总', () => {
  it('只有未越界且点名项齐全才算 grounded', () => {
    expect(
      groundedness([
        { id: 'a', observation: answer([], []) },
        { id: 'b', observation: answer(['ghost/repo'], []) },
        { id: 'c', observation: answer([], ['astral-sh/ruff']) },
      ]),
    ).toBeCloseTo(1 / 3);
  });

  it('汇总指标包含逐字段准确率与运行时错误', () => {
    const metrics = computeMetrics({
      routes: [],
      parses: [parseSample({ topN: 3 }, { topN: 3 })],
      answers: [],
      runtimeErrors: 2,
    });
    expect(metrics.parse_field_topN).toBe(1);
    expect(metrics.runtime_errors).toBe(2);
    expect(metrics.groundedness).toBe(1);
  });
});

describe('eval report — 阈值与基线方向', () => {
  it('越大越好的指标下降是回退', () => {
    expect(compareMetric('route_accuracy', 0.9, 1)).toBe(-1);
    expect(compareMetric('route_accuracy', 1, 1)).toBe(0);
  });

  it('越小越好的指标上升是回退', () => {
    expect(compareMetric('runtime_errors', 1, 0)).toBe(-1);
    expect(compareMetric('rule_false_positive_rate', 0, 0.1)).toBe(1);
  });

  it('基线比较同时给出回退与修复', () => {
    const result = compareBaseline(
      { route_accuracy: 1, runtime_errors: 1, groundedness: 0.9 },
      { route_accuracy: 0.9, runtime_errors: 0, groundedness: 1 },
    );
    expect(result.regressions.sort()).toEqual(['groundedness', 'runtime_errors']);
    expect(result.fixes).toEqual(['route_accuracy']);
  });

  it('阈值：运行时错误有错即失败，缺失的指标不检查', () => {
    expect(checkThresholds({ runtime_errors: 1 })).toHaveLength(1);
    expect(checkThresholds({ route_accuracy: 1 })).toEqual([]);
  });

  it('解析准确率低于 0.95 失败', () => {
    expect(checkThresholds({ parse_exact_match: 0.94 })).toHaveLength(1);
  });
});
