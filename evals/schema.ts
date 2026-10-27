import { z } from 'zod';

/**
 * 金标用例的契约。
 *
 * 原则：**字段省略 = 不计分**。一条 routing 用例不写 parse，就不会被拿去算
 * 解析准确率；这样同一份文件可以只断言它真正关心的那一层，避免把
 * fallbackParse 的偶然行为固化成「正确答案」。
 */

/** 路由期望：handler（去哪条分支）或 usage（该回哪条用法提示）。 */
export const RouteExpectationSchema = z.object({
  kind: z.enum(['handler', 'usage']),
  name: z.string().min(1),
});

/**
 * 解析期望：所有字段可选，只比较写出来的。
 * 无信号的字段在用例里省略——不要求模型/规则恰好输出默认值。
 */
export const ParseExpectationSchema = z.object({
  intent: z.enum(['search', 'about', 'off_topic']).optional(),
  languages: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  period: z.enum(['today', 'week', 'month', 'all']).optional(),
  minStars: z.number().nullable().optional(),
  sortBy: z.enum(['stars_delta', 'stars', 'new']).optional(),
  topN: z.number().optional(),
});

/** 答案期望：fixture 提供结果集，必须在回复里出现的仓库写进 mustMention。 */
export const AnswerExpectationSchema = z.object({
  /** 相对仓库根目录的 fixture 路径，如 evals/fixtures/search/python-ai.json。 */
  fixture: z.string().min(1),
  mustMention: z.array(z.string()).optional(),
});

/** 工具路由期望（Phase 2 起生效；当前 adapter 返回 skipped）。 */
export const ToolsExpectationSchema = z.object({
  route: z.enum(['tools', 'search', 'parse']),
  tool: z.string().optional(),
});

export const GoldenExpectedSchema = z
  .object({
    route: RouteExpectationSchema.optional(),
    parse: ParseExpectationSchema.optional(),
    answer: AnswerExpectationSchema.optional(),
    tools: ToolsExpectationSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'expected 至少要写一项（route / parse / answer / tools）',
  });

export const GoldenCaseSchema = z.object({
  /** 唯一 ID：小写字母/数字/连字符，便于报告里稳定引用。 */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能是小写字母、数字与连字符'),
  text: z.string().min(1),
  /** 为什么收录这条（尤其是对抗样例），给后来改规则的人看。 */
  notes: z.string().optional(),
  expected: GoldenExpectedSchema,
});

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type ParseExpectation = z.infer<typeof ParseExpectationSchema>;
export type AnswerExpectation = z.infer<typeof AnswerExpectationSchema>;
export type ToolsExpectation = z.infer<typeof ToolsExpectationSchema>;

/** 禁止出现的字段：金标集不进任何用户标识（匿名是硬约束）。 */
export const FORBIDDEN_KEYS = new Set([
  'userid',
  'userId',
  'fromUserName',
  'wecomUserid',
  'wecom_userid',
]);

/** 找出对象里所有违禁键（递归；数组也走）。 */
export function findForbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      found.push(`${path}.${key}`);
    }
    found.push(...findForbiddenKeys(child, `${path}.${key}`));
  }
  return found;
}
