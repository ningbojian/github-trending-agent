import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Abstract（简报开头一段整合概览）：只测纯逻辑与失败降级，绝不触网。
 * llm 模块整体打桩，generateObjectSafe 的返回由 llmState 控制。
 */

const llmState = vi.hoisted(() => ({
  result: null as { abstract: string } | null,
  fail: false,
  prompts: [] as string[],
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: async (_schema: unknown, prompt: string) => {
    llmState.prompts.push(prompt);
    if (llmState.fail) throw new Error('llm down');
    return llmState.result;
  },
}));

const {
  ABSTRACT_MAX_CHARS,
  buildAbstractPrompt,
  loadAbstractSafe,
  truncateChars,
} = await import('../src/agent/abstract');

function item(fullName: string) {
  return { fullName };
}

beforeEach(() => {
  llmState.result = null;
  llmState.fail = false;
  llmState.prompts = [];
});

describe('buildAbstractPrompt', () => {
  it('要求 2–3 句、120 字以内，并带上仓库名与中文简介', () => {
    const prompt = buildAbstractPrompt(
      [item('a/one'), item('b/two')],
      new Map([['a/one', '一个 AI 工具']]),
    );
    expect(prompt).toContain('2 到 3 句');
    expect(prompt).toContain(String(ABSTRACT_MAX_CHARS));
    expect(prompt).toContain('a/one：一个 AI 工具');
    // 没有简介的仓库仍然出现在列表里（只是没有冒号后段）。
    expect(prompt).toContain('- b/two');
    expect(prompt).not.toContain('b/two：');
  });
});

describe('truncateChars', () => {
  it('按码点截断，不切断代理对', () => {
    const text = '😀'.repeat(10);
    const out = truncateChars(text, 4);
    expect(Array.from(out)).toHaveLength(4);
    expect(out).toBe('😀😀😀😀');
  });

  it('未超长时原样返回并去掉首尾空白', () => {
    expect(truncateChars('  短句  ', 10)).toBe('短句');
  });
});

describe('loadAbstractSafe', () => {
  it('返回模型给出的概览，并按 120 码点截断', async () => {
    llmState.result = { abstract: '今'.repeat(200) };
    const out = await loadAbstractSafe([item('a/one')], new Map());
    expect(Array.from(out ?? '')).toHaveLength(ABSTRACT_MAX_CHARS);
  });

  it('模型返回 null 时返回 null', async () => {
    llmState.result = null;
    expect(await loadAbstractSafe([item('a/one')], new Map())).toBeNull();
  });

  it('模型抛错时返回 null，绝不外抛', async () => {
    llmState.fail = true;
    await expect(loadAbstractSafe([item('a/one')], new Map())).resolves.toBeNull();
  });

  it('模型返回空白概览时返回 null（不写空段落）', async () => {
    llmState.result = { abstract: '   ' };
    expect(await loadAbstractSafe([item('a/one')], new Map())).toBeNull();
  });

  it('没有条目时直接返回 null，不调用模型', async () => {
    llmState.result = { abstract: '不该被用到' };
    expect(await loadAbstractSafe([], new Map())).toBeNull();
    expect(llmState.prompts).toHaveLength(0);
  });
});
