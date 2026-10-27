import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, kvCache } from '../db/schema.js';

/**
 * 请求级 trace：一条入站消息（或一个订阅者的一次推送）一行记录。
 *
 * 为什么需要：全仓的 `console.*` 直接进 Vercel Function Logs——要登录控制台、
 * 只留几天，而且没有请求 id：同一条消息的「路由 → 规则意图 → 模型解析 →
 * 检索 → 简介 → 发送」是六七条互不关联的散行，多用户并发时根本串不起来。
 *
 * 为什么用 AsyncLocalStorage 而不是模块级变量：Fluid Compute 会复用实例并发
 * 处理请求，模块变量会被隔壁请求写乱；ALS 按异步上下文隔离，且不用给
 * 15 个 handler 都加一个 trace 参数。
 *
 * 为什么不建表：迁移 0004 的 journal `when` 会早于 0003（1793200000001），
 * drizzle 会静默跳过（docs/deploy.md 第 1 节）。7 天 TTL 也省掉了清理任务。
 *
 * 观测永远不能把业务弄挂：任何写库/序列化异常都在这里吞掉。
 */

export type TraceKind = 'text' | 'event' | 'push' | 'other';

export interface TraceStep {
  /** 距上一步（首步距开始）的毫秒数，直接看出哪一段慢。 */
  ms: number;
  name: string;
  detail?: string;
}

export interface TraceMeta {
  kind: TraceKind;
  userid: string;
  text?: string;
}

/** 7 天：够回溯「昨天那条为什么没回我」，又不至于把 kv_cache 撑大。 */
export const TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 步骤上限：正常一次调用 5–10 步，超过说明有人加了循环埋点。 */
export const TRACE_MAX_STEPS = 40;
/** 原话上限：trace 是运行日志，不是聊天记录。 */
export const TRACE_TEXT_MAX_CHARS = 80;

interface TraceContext {
  /** 一次调用一个 id；tool_calls.run_id 与它对应。 */
  runId: string;
  meta: TraceMeta;
  startAt: number;
  lastAt: number;
  steps: TraceStep[];
  ok: boolean;
  errorRecorded: boolean;
  truncated: boolean;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** 当前请求的 run id；不在 trace 内（或测试直调）返回 null。 */
export function currentTraceId(): string | null {
  return storage.getStore()?.runId ?? null;
}

function now(): number {
  return Date.now();
}

/** 观测数据里不得出现明文 Key。 */
function redact(text: string): string {
  return text.replace(/sk-[\w-]{8,}/g, 'sk-***');
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message).slice(0, 300);
}

export function truncateText(text: string): string {
  return Array.from(text).slice(0, TRACE_TEXT_MAX_CHARS).join('');
}

function pushStep(ctx: TraceContext, name: string, detail?: string): void {
  if (ctx.steps.length >= TRACE_MAX_STEPS) {
    if (!ctx.truncated) {
      ctx.truncated = true;
      ctx.steps.push({ ms: now() - ctx.lastAt, name: 'truncated' });
    }
    return;
  }
  const step: TraceStep = { ms: now() - ctx.lastAt, name };
  if (detail !== undefined) {
    step.detail = detail;
  }
  ctx.steps.push(step);
  ctx.lastAt = now();
}

/**
 * 在当前调用上记一步。没有 trace 上下文时静默 no-op——
 * 这样既有的单测路径和脚本调用都不需要感知它。
 */
export function note(name: string, detail?: string): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  pushStep(ctx, name, detail);
}

/** 记一次失败并把整条 trace 标记为不成功；同一异常只记一次。 */
export function traceError(err: unknown): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.ok = false;
  if (ctx.errorRecorded) {
    return;
  }
  ctx.errorRecorded = true;
  pushStep(ctx, 'error', describeError(err));
}

/** 落库 + 打一行 JSON（Vercel 日志里也能看）。任何异常都吞掉。 */
async function flushTrace(ctx: TraceContext): Promise<void> {
  const value = {
    kind: ctx.meta.kind,
    userid: ctx.meta.userid,
    text: truncateText(ctx.meta.text ?? ''),
    totalMs: now() - ctx.startAt,
    ok: ctx.ok,
    steps: ctx.steps,
  };
  // 正式表是主路径：可按时间/用户/类型查询与聚合。
  try {
    console.log('[trace]', JSON.stringify({ id: ctx.runId, ...value }));
    await db().insert(agentRuns).values({
      id: ctx.runId,
      ...value,
      createdAt: new Date(ctx.startAt),
    });
    return;
  } catch (err) {
    console.error(
      '[trace] agent_runs write failed, falling back to kv_cache:',
      err instanceof Error ? err.message : err,
    );
  }
  // 降级路径：迁移未执行/临时故障时仍然留痕。7 天 TTL 顺带当清理。
  try {
    // key 以 ISO 时间开头：字典序倒排 = 时间倒排，页面按 key desc 取最新。
    const key = `trace:${new Date(ctx.startAt).toISOString()}-${ctx.runId.slice(0, 8)}`;
    await db()
      .insert(kvCache)
      .values({
        key,
        value,
        expiresAt: new Date(now() + TRACE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.error(
      '[trace] kv fallback failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * 包住一次调用：内部的 `note()` 都挂到这条 trace 上，结束时（含抛错）落库。
 * 异常照常抛给调用方——trace 只观察，不改变行为。
 */
export async function withTrace<T>(
  meta: TraceMeta,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = now();
  const ctx: TraceContext = {
    runId: randomUUID(),
    meta,
    startAt: startedAt,
    lastAt: startedAt,
    steps: [],
    ok: true,
    errorRecorded: false,
    truncated: false,
  };
  try {
    return await storage.run(ctx, fn);
  } catch (err) {
    ctx.ok = false;
    if (!ctx.errorRecorded) {
      ctx.errorRecorded = true;
      pushStep(ctx, 'error', describeError(err));
    }
    throw err;
  } finally {
    await flushTrace(ctx);
  }
}
