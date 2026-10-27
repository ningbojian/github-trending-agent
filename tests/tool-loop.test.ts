import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import { runToolLoopSafe, type GenerateTextFn } from '../src/agent/tool-loop';

/**
 * 工具循环的安全壳：超时、不重试、步数上限、失败降级为 null。
 * generateText 注入，测试不调模型。
 */

const model = { modelId: 'fake' } as unknown as LanguageModel;

interface Captured {
  args: Parameters<GenerateTextFn>[0];
}

function setup(
  impl: GenerateTextFn,
  options: { timeoutMs?: number; maxSteps?: number } = {},
) {
  const captured: Captured[] = [];
  const notes: Array<{ name: string; detail?: string }> = [];
  const errors: unknown[] = [];
  const usages: Array<[number | undefined, number | undefined]> = [];
  const run = () =>
    runToolLoopSafe(
      { system: '你是助手', prompt: '深挖 astral-sh/ruff' },
      {
        model,
        tools: {},
        timeoutMs: options.timeoutMs,
        maxSteps: options.maxSteps,
        generate: (args) => {
          captured.push({ args });
          return impl(args);
        },
        noteFn: (name, detail) => notes.push({ name, detail }),
        traceErrorFn: (err) => errors.push(err),
        usageFn: (input, output) => usages.push([input, output]),
      },
    );
  return { run, captured, notes, errors, usages };
}

describe('runToolLoopSafe — 参数', () => {
  it('显式传 stopWhen / maxRetries=0 / abortSignal', async () => {
    const { run, captured } = setup(async () => ({
      text: '结论',
      steps: [{ toolCalls: [{ toolName: 'repo_health' }] }],
    }));
    await run();
    const args = captured[0]?.args;
    expect(args).toBeDefined();
    if (args === undefined) return;
    expect(args.maxRetries).toBe(0);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    // 默认 stopWhen 只有 1 步——必须显式传成 3 步，否则模型拿到工具结果没机会总结。
    expect(typeof args.stopWhen).toBe('function');
    const stopWhen = args.stopWhen as (options: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [{}, {}] })).toBe(false);
    expect(stopWhen({ steps: [{}, {}, {}] })).toBe(true);
  });

  it('maxSteps 可覆盖', async () => {
    const { run, captured } = setup(
      async () => ({ text: '结论', steps: [] }),
      { maxSteps: 2 },
    );
    await run();
    const stopWhen = captured[0]?.args.stopWhen as (options: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [{}, {}] })).toBe(true);
    expect(stopWhen({ steps: [{}] })).toBe(false);
  });
});

describe('runToolLoopSafe — 结果', () => {
  it('成功时返回文本、步数与调用过的工具', async () => {
    const { run, notes } = setup(async () => ({
      text: '  ruff 是个很活跃的 linter。 ',
      steps: [
        { toolCalls: [{ toolName: 'deep_dive_repo' }] },
        { toolCalls: [{ toolName: 'repo_health' }] },
      ],
    }));
    const result = await run();
    expect(result).toEqual({
      text: 'ruff 是个很活跃的 linter。',
      steps: 2,
      tools: ['deep_dive_repo', 'repo_health'],
    });
    const note = notes.find((item) => item.name === 'tool-steps');
    expect(note?.detail).toContain('deep_dive_repo');
  });

  it('模型抛错 → null，并记一条脱敏的错误 note', async () => {
    const { run, notes, errors } = setup(async () => {
      throw new Error('401 sk-abcdefghijklmnop');
    });
    const result = await run();
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    const note = notes.find((item) => item.name === 'tool-error');
    expect(note?.detail).toContain('401');
    expect(note?.detail).not.toContain('sk-abcdefghijklmnop');
  });

  it('空文本 → null（宁可回退模板，也不发一句空话）', async () => {
    const { run } = setup(async () => ({ text: '   ', steps: [{ toolCalls: [] }] }));
    expect(await run()).toBeNull();
  });

  it('用量上报给 trace：兼容 inputTokens 与旧的 promptTokens 两套字段名', async () => {
    const modern = setup(async () => ({
      text: '好',
      steps: [],
      usage: { inputTokens: 120, outputTokens: 30 },
    }));
    await modern.run();
    expect(modern.usages).toEqual([[120, 30]]);

    const legacy = setup(async () => ({
      text: '好',
      steps: [],
      usage: { promptTokens: 55, completionTokens: 7 },
    }));
    await legacy.run();
    expect(legacy.usages).toEqual([[55, 7]]);
  });

  it('steps 字段缺失也能活（SDK 版本差异不该崩）', async () => {
    const { run } = setup(async () => ({ text: '好' }) as Awaited<ReturnType<GenerateTextFn>>);
    expect(await run()).toEqual({ text: '好', steps: 0, tools: [] });
  });

  it('超时中止 → null（默认 15 秒上限，测试用 20ms）', async () => {
    const { run, notes } = setup(
      (args) =>
        new Promise((_resolve, reject) => {
          args.abortSignal.addEventListener('abort', () => {
            reject(new Error('The operation was aborted'));
          });
        }),
      { timeoutMs: 20 },
    );
    const result = await run();
    expect(result).toBeNull();
    expect(notes.some((item) => item.name === 'tool-error')).toBe(true);
  });
});
