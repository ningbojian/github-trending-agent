import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { toolCalls } from '../db/schema.js';
import { currentTraceId } from './trace.js';

/**
 * 工具调用流水：一行一次调用，关联到发起它的那次 run。
 *
 * 为什么只存参数哈希：工具参数里可能带用户原话（`deep_dive_repo { repo }`、
 * `manage_subscription { term }`）。排障要看的是「同一个参数调了几次、慢在哪」，
 * 不是再抄一份用户内容进库。
 *
 * 为什么不在 trace 内就跳过：定时推送、脚本、单测没有 run id，硬写会产生
 * 孤儿行，反而让 `tool_calls.run_id` 的关联失去意义。
 *
 * 观测永远不能把工具弄挂：写库失败只打日志，返回 false。
 */

export interface ToolCallInput {
  tool: string;
  args: unknown;
  status: 'ok' | 'error';
  latencyMs: number;
}

/** 16 位十六进制足够区分参数，又比 64 位短一半。 */
const HASH_CHARS = 16;

export function hashArgs(args: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    // 循环引用 / BigInt：仍然要留一个稳定的占位，而不是让整次调用失败。
    return 'unhashable';
  }
  if (json === undefined) {
    return 'undefined';
  }
  return createHash('sha256').update(json).digest('hex').slice(0, HASH_CHARS);
}

export async function recordToolCall(input: ToolCallInput): Promise<boolean> {
  const runId = currentTraceId();
  if (runId === null) {
    return false;
  }
  try {
    await db()
      .insert(toolCalls)
      .values({
        runId,
        tool: input.tool,
        argsHash: hashArgs(input.args),
        status: input.status,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
      });
    return true;
  } catch (err) {
    console.error(
      '[tool-calls] write failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
