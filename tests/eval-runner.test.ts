import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitCodeFor } from '../evals/cli';
import { formatReport } from '../evals/report';
import { readBaseline, runEval } from '../evals/run';

function goldenDir(cases: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-run-'));
  writeFileSync(
    join(dir, 'cases.jsonl'),
    cases.map((item) => JSON.stringify(item)).join('\n'),
    'utf8',
  );
  return dir;
}

const ROUTE_OK = {
  id: 'route-help',
  text: '帮助',
  expected: { route: { kind: 'handler', name: 'help' } },
};

const PARSE_OK = {
  id: 'parse-python',
  text: '本周 python 的 ai 项目',
  expected: { parse: { languages: ['python'], keywords: ['ai'] } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('eval runner — 结果与确定性', () => {
  it('同一输入跑两次结果一致', async () => {
    const dir = goldenDir([ROUTE_OK, PARSE_OK]);
    const first = await runEval({ goldenDir: dir });
    const second = await runEval({ goldenDir: dir });
    expect(second).toEqual(first);
  });

  it('runner 不调用 process.exit（退出码归 CLI）', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runEval({ goldenDir: goldenDir([ROUTE_OK]) });
    expect(exit).not.toHaveBeenCalled();
  });

  it('路由全中时准确率为 1，且没有失败项', async () => {
    const result = await runEval({ goldenDir: goldenDir([ROUTE_OK]) });
    expect(result.metrics.route_accuracy).toBe(1);
    expect(result.routeFailures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('期望写错时产出可读的失败记录', async () => {
    const result = await runEval({
      goldenDir: goldenDir([
        { ...ROUTE_OK, expected: { route: { kind: 'handler', name: 'favorite' } } },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.routeFailures[0]).toMatchObject({
      id: 'route-help',
      expected: 'handler:favorite',
      actual: 'handler:help',
    });
  });

  it('fixture 缺失 → 记运行时错误，不把异常抛给调用方', async () => {
    const result = await runEval({
      goldenDir: goldenDir([
        {
          id: 'answer-missing',
          text: '本周 python',
          expected: { answer: { fixture: 'evals/fixtures/search/does-not-exist.json' } },
        },
      ]),
    });
    expect(result.metrics.runtime_errors).toBe(1);
    expect(result.answerFailures[0]?.actual).toContain('运行时错误');
    expect(result.ok).toBe(false);
  });

  it('tools 用例计入 skipped 而不是失败', async () => {
    const result = await runEval({
      goldenDir: goldenDir([
        {
          id: 'tools-deep-dive',
          text: '深挖 astral-sh/ruff',
          expected: { tools: { route: 'tools', tool: 'deep_dive_repo' } },
        },
      ]),
    });
    expect(result.skippedTools).toBe(1);
    expect(result.ok).toBe(true);
  });
});

describe('eval runner — 基线比较', () => {
  it('指标低于基线时记为回退并失败', async () => {
    const dir = goldenDir([
      { ...ROUTE_OK, expected: { route: { kind: 'handler', name: 'favorite' } } },
    ]);
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(
      baselinePath,
      JSON.stringify({ metrics: { route_accuracy: 1 } }),
      'utf8',
    );
    const result = await runEval({ goldenDir: dir, compare: true, baselinePath });
    expect(result.regressions).toContain('route_accuracy');
    expect(result.ok).toBe(false);
  });

  it('基线文件缺失时静默跳过比较', async () => {
    const dir = goldenDir([ROUTE_OK]);
    const result = await runEval({
      goldenDir: dir,
      compare: true,
      baselinePath: join(dir, 'nope.json'),
    });
    expect(result.regressions).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('兼容只有数值的基线对象', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    const file = join(dir, 'b.json');
    writeFileSync(file, JSON.stringify({ route_accuracy: 0.5, note: 'x' }), 'utf8');
    expect(readBaseline(file)).toEqual({ route_accuracy: 0.5 });
  });
});

describe('eval CLI — 退出码与报告', () => {
  it('通过 0，未通过 1', () => {
    expect(exitCodeFor(true)).toBe(0);
    expect(exitCodeFor(false)).toBe(1);
  });

  it('报告打印关键指标与失败样例', async () => {
    const result = await runEval({
      goldenDir: goldenDir([
        { ...ROUTE_OK, expected: { route: { kind: 'handler', name: 'favorite' } } },
      ]),
    });
    const text = formatReport(result);
    expect(text).toContain('路由准确率');
    expect(text).toContain('路由失败（1）');
    expect(text).toContain('❌ 评测未通过');
  });
});
