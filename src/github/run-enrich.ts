import { pathToFileURL } from 'node:url';
import { env } from '../config';
import { db } from '../db/client';
import { repos } from '../db/schema';
import { enrichMissingTopics } from './enrich';

/**
 * CLI 入口：查询 repos 表中 topics 为空的仓库，调 GitHub API 补全元数据。
 * GITHUB_TOKEN 缺失时告警并跳过（exit 0，不阻断每日管线的后续推送步骤）；
 * 其他异常 exit 1，交由 Actions 的 `if: failure()` 步骤触发企微告警。
 */
export async function main(): Promise<void> {
  try {
    const token = env.GITHUB_TOKEN;
    if (!token) {
      console.warn(
        '[enrich] GITHUB_TOKEN not set — skipping enrichment (repos keep empty topics)',
      );
      return;
    }

    const rows = await db()
      .select({ fullName: repos.fullName, topics: repos.topics })
      .from(repos);
    const pending = rows
      .filter((row) => !row.topics || row.topics.length === 0)
      .map((row) => row.fullName);

    if (pending.length === 0) {
      console.log('[enrich] no repos need enrichment');
      return;
    }

    const count = await enrichMissingTopics(pending, token);
    console.log(
      `[enrich] done: ${count} repo(s) enriched out of ${pending.length} pending`,
    );
  } catch (error) {
    console.error('[enrich] failed:', error);
    process.exitCode = 1;
  }
}

// 仅在作为脚本直接运行时执行（被测试导入时不产生副作用）。
if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
