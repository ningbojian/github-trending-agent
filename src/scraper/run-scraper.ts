import { pathToFileURL } from 'node:url';
import { scrapeAndUpsert } from './trending.js';

/**
 * CLI 入口：抓取 GitHub Trending 并入库。
 * inserted === 0 时 exit 1（或任何异常时也 exit 1），
 * 让 GitHub Actions 的定时任务失败并触发告警。
 */
export async function main(): Promise<void> {
  try {
    const { inserted, languages } = await scrapeAndUpsert();
    console.log(
      `[scraper] done: ${inserted} entries upserted across ${languages} language page(s)`,
    );
    if (inserted === 0) {
      console.error(
        '[scraper] no trending entries captured — exiting 1 to trigger alerting',
      );
      process.exit(1);
    }
  } catch (error) {
    console.error('[scraper] failed:', error);
    process.exit(1);
  }
}

// 仅在作为脚本直接运行时执行（被测试导入时不产生副作用）。
if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
