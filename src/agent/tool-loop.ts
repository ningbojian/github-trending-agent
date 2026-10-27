import { generateText, stepCountIs, type LanguageModel } from 'ai';
import { note, traceError } from '../obs/trace.js';
import { redactKey } from './llm.js';

/**
 * 工具循环的安全壳。
 *
 * 为什么不是直接调 `generateText`：
 * - **默认 `stopWhen` 只有 1 步**。不显式传 `stepCountIs(3)`，模型调完工具就拿不到
 *   结果、更没机会总结，用户只会看到一句「正在处理」然后什么也没有。
 * - **必须关掉 SDK 重试**（`maxRetries: 0`）：3 步 × 默认 2 次重试 = 最多 9 次
 *   串行请求，会把 15 秒预算拖成分钟级，而回执链路本来就只有 5 秒容身之处。
 * - **必须有硬超时**：模型卡住时不能把整个 `waitUntil` 拖到 `maxDuration`。
 * - 失败一律返回 `null`，由调用方回退到「检索 + 模板排版」这条免费路径——
 *   工具是增强，不是单点故障。
 *
 * 不记录原始 token：只记步数与工具名（`note('tool-steps', …)`），
 * 排障需要的是「调了哪个工具、几步」，不是把用户对话再抄一份进 kv_cache。
 */

/** 默认最多 3 步（1 次工具调用 + 1 次总结，留一步余量）。 */
export const DEFAULT_MAX_STEPS = 3;
/** 整个循环的硬上限：超过就放弃，回退模板。 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface GenerateTextStep {
  toolCalls?: Array<{ toolName?: string }>;
}

export interface GenerateTextOutput {
  text?: string;
  steps?: GenerateTextStep[];
}

/** `generateText` 的最小结构（测试注入用；真实实现由下方 cast 适配）。 */
export type GenerateTextFn = (options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools: Record<string, unknown>;
  stopWhen: unknown;
  maxRetries: number;
  abortSignal: AbortSignal;
}) => Promise<GenerateTextOutput>;

export interface ToolLoopInput {
  system: string;
  prompt: string;
}

export interface ToolLoopOptions {
  model: LanguageModel;
  tools: Record<string, unknown>;
  /** 默认使用真实 `generateText`；测试注入。 */
  generate?: GenerateTextFn;
  maxSteps?: number;
  timeoutMs?: number;
  noteFn?: (name: string, detail?: string) => void;
  traceErrorFn?: (err: unknown) => void;
}

export interface ToolLoopOutcome {
  text: string;
  steps: number;
  /** 按调用顺序去重的工具名。 */
  tools: string[];
}

function collectToolNames(steps: GenerateTextStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      const name = call.toolName;
      if (typeof name === 'string' && name !== '' && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

export async function runToolLoopSafe(
  input: ToolLoopInput,
  options: ToolLoopOptions,
): Promise<ToolLoopOutcome | null> {
  const generate: GenerateTextFn =
    options.generate ?? (generateText as unknown as GenerateTextFn);
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const noteFn = options.noteFn ?? note;
  const recordError = options.traceErrorFn ?? traceError;

  try {
    const result = await generate({
      model: options.model,
      system: input.system,
      prompt: input.prompt,
      tools: options.tools,
      stopWhen: stepCountIs(maxSteps),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const steps = Array.isArray(result.steps) ? result.steps : [];
    const tools = collectToolNames(steps);
    noteFn('tool-steps', `steps=${steps.length} tools=${tools.join(',') || 'none'}`);

    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (text === '') {
      return null;
    }
    return { text, steps: steps.length, tools };
  } catch (err) {
    const message = redactKey(err instanceof Error ? err.message : String(err)).slice(0, 200);
    noteFn('tool-error', message);
    recordError(err);
    return null;
  }
}
