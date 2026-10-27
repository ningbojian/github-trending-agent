import { describe, expect, it } from 'vitest';
import { loadGolden } from '../evals/load';
import { runEval } from '../evals/run';

/**
 * 入库金标的门禁：这组用例断言的是「仓库里现在这份金标 + 基线」本身。
 * 改坏一条规则 → 这里红；改好一条规则 → 先跑 npm run eval:baseline。
 */
describe('eval golden — 金标集与基线', () => {
  it('确定性指标达到阈值，且相对基线没有回退', async () => {
    const result = await runEval({ mode: 'deterministic', compare: true });
    expect(result.thresholdFailures).toEqual([]);
    expect(result.regressions).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('每个 handler 都有路由用例（新增 handler 时这条会提醒补样本）', () => {
    const handlers = new Set(
      loadGolden()
        .filter((item) => item.expected.route?.kind === 'handler')
        .map((item) => item.expected.route?.name),
    );
    expect([...handlers].sort()).toEqual(
      [
        'bind',
        'cancelSubscription',
        'clearModel',
        'digestCount',
        'favorite',
        'help',
        'interested',
        'list',
        'memory',
        'myModel',
        'mySubscription',
        'notInterested',
        'pushInterval',
        'pushTime',
        'search',
        'setModel',
        'subscribe',
        'unfavorite',
        'unsubscribe',
      ].sort(),
    );
  });

  it('用法提示也有用例（错字不能落成搜索）', () => {
    const usages = new Set(
      loadGolden()
        .filter((item) => item.expected.route?.kind === 'usage')
        .map((item) => item.expected.route?.name),
    );
    for (const name of ['favorite', 'unfavorite', 'list', 'mySubscription', 'bind']) {
      expect(usages.has(name)).toBe(true);
    }
  });

  it('金标集里没有任何用户标识字段', () => {
    const raw = loadGolden();
    expect(JSON.stringify(raw)).not.toMatch(/wecomUserid|userid|fromUserName/i);
  });
});
