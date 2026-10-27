import { generateText, stepCountIs, type LanguageModel } from 'ai';
import { note, traceError } from '../obs/trace.js';
import { recordToolCall, type ToolCallInput } from '../obs/tool-calls.js';
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
  /** 默认写 `tool_calls`；测试注入。 */
  recordToolCall?: ToolCallRecorder;
}

/** 工具调用流水注入点；默认落库，测试可换成一个数组。 */
export type ToolCallRecorder = (input: ToolCallInput) => Promise<unknown>;

/**
 * 给每个工具的 `execute` 计时并记一条流水。
 *
 * - **不改变返回值**：成功原样返回，失败原样抛——记录是旁路，不是包装语义。
 * - **没有 `execute` 的定义原样保留**（schema-only 工具不该被复制成新对象）。
 * - **记录器抛错也吞掉**：观测失败绝不能连累工具本身。
 */
export function instrumentTools(
  tools: Record<string, unknown>,
  record: ToolCallRecorder = recordToolCall,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  const safeRecord = async (input: ToolCallInput): Promise<void> => {
    try {
      await record(input);
    } catch (err) {
      console.error(
        '[tool-loop] tool call record failed:',
        err instanceof Error ? err.message : err,
      );
    }
  };

  for (const [name, definition] of Object.entries(tools)) {
    const execute = (definition as { execute?: unknown } | null)?.execute;
    if (typeof execute !== 'function') {
      wrapped[name] = definition;
      continue;
    }
    const run = execute as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = {
      ...(definition as Record<string, unknown>),
      execute: async (args: unknown, ...rest: unknown[]) => {
        const startedAt = Date.now();
        try {
          const result = await run(args, ...rest);
          await safeRecord({
            tool: name,
            args,
            status: 'ok',
            latencyMs: Date.now() - startedAt,
          });
          return result;
        } catch (err) {
          await safeRecord({
            tool: name,
            args,
            status: 'error',
            latencyMs: Date.now() - startedAt,
          });
          throw err;
        }
      },
    };
  }
  return wrapped;
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
      tools: instrumentTools(options.tools, options.recordToolCall),
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
