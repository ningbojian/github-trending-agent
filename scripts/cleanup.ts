import { neon } from '@neondatabase/serverless';
import { pathToFileURL } from 'node:url';

/**
 * 可观测表清理：删除 30 天前的 agent_runs / tool_calls。
 *
 * 为什么单独脚本、不走 src/db/client.ts：那个模块导入即触发 config 的全量
 * zod 校验（要求 LLM key、企微 callback 等十几个变量）。清理只需要一个
 * DATABASE_URL，跟 db-audit.ts 一样直连，GitHub Actions 里只注入一个 secret。
 *
 * 30 天够回溯「上个月那条为什么没回我」，再老的行对排障没有价值，
 * 却会拖慢 /api/metrics 的聚合查询并占用 Neon 存储。
 * kv_cache 的 trace 降级路径自带 7 天 TTL，不需要清理。
 *
 * daily.yml 每天跑一次：删除是幂等的，重复跑没有副作用。
 */

const RETENTION_DAYS = 30;

function loadDsn(): string {
  const dsn = process.env.NEON_DATABASE_URL;
  if (!dsn) {
    throw new Error('NEON_DATABASE_URL is required');
  }
  return dsn;
}

/** 只依赖「执行带参数的 SQL」这一能力，测试可注入假执行器，不连库。 */
export type SqlExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export async function cleanup(
  sql: SqlExecutor,
  now: Date = new Date(),
): Promise<{ agentRuns: number; toolCalls: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const runs = await sql`
    DELETE FROM agent_runs WHERE created_at < ${cutoff.toISOString()}
  `;
  const calls = await sql`
    DELETE FROM tool_calls WHERE created_at < ${cutoff.toISOString()}
  `;

  return {
    agentRuns: runs.length,
    toolCalls: calls.length,
  };
}

async function main(): Promise<void> {
  const result = await cleanup(neon(loadDsn()));
  console.log(
    `[cleanup] removed ${result.agentRuns} agent_runs, ${result.toolCalls} tool_calls older than ${RETENTION_DAYS} days`,
  );
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
