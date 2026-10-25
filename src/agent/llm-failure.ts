import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

/**
 * 记录最近一次 LLM 调用失败，写进 kv_cache（key `llm:last-error`，6 小时过期）。
 *
 * 为什么需要：失败现场只有 `console.error`，而 Vercel 函数日志既需要
 * 额外的访问凭据、又会在几天后过期。线上唯一可见的症状是「简介一直是英文」，
 * 分不清是密钥、模型名还是请求体不被网关接受。把它落到数据库里，
 * 用一条 SELECT 就能看到真正的报错。
 *
 * 刻意不抛错、不阻塞主流程：诊断用信息永远不能反过来把业务流程弄挂。
 */

/** 诊断记录的缓存 key。 */
const FAILURE_KEY = 'llm:last-error';
/** 6 小时：足够覆盖「等下一个整点触发」的验证窗口，又不至于留下陈旧噪音。 */
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;

export interface LlmFailure {
  provider: string;
  model: string;
  message: string;
}

/** 上报一次 LLM 失败；任何异常都被吞掉（本函数只做观测）。 */
export async function recordLlmFailure(failure: LlmFailure): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: FAILURE_KEY,
        value: {
          ...failure,
          // 只保留前 500 字符：错误体可能很长，且不该把整个响应塞进库。
          message: failure.message.slice(0, 500),
          at: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + FAILURE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    // 连数据库都写不进去时退回到日志，绝不冒泡。
    console.error(
      '[llm] failed to record failure:',
      err instanceof Error ? err.message : err,
    );
  }
}
