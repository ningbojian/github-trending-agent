import { sql } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { shanghaiToday } from '../agent/time.js';
import { db } from '../db/client.js';
import { sourceItems } from '../db/schema.js';
import { githubSearchAdapter } from './github-search.js';
import { hackerNewsAdapter } from './hackernews.js';
import { hfModelsAdapter, hfSpacesAdapter } from './hf.js';
import { lobstersAdapter } from './lobsters.js';
import type { SourceAdapter, SourceItemInput } from './types.js';

/**
 * 多源抓取 CLI（在 GitHub Actions 里跑，不需要新的 Serverless Function）。
 *
 * 每个源独立 try/catch：Hugging Face 在部分网络不可达、HN/Lobsters 偶尔
 * 抖一下，都不该拖垮其他源。全部源都失败或总条数为 0 才退出 1（触发告警）。
 */

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  hfModelsAdapter,
  hfSpacesAdapter,
  githubSearchAdapter,
  hackerNewsAdapter,
  lobstersAdapter,
];

export interface SourceRunResult {
  id: string;
  label: string;
  count: number;
  error?: string;
}

function uniqueById(items: SourceItemInput[]): SourceItemInput[] {
  const seen = new Set<string>();
  const out: SourceItemInput[] = [];
  for (const item of items) {
    if (seen.has(item.sourceId)) continue;
    seen.add(item.sourceId);
    out.push(item);
  }
  return out;
}

async function store(
  source: string,
  date: string,
  items: SourceItemInput[],
  now: Date,
): Promise<void> {
  const rows = uniqueById(items).map((item) => ({
    source: item.source,
    sourceId: item.sourceId,
    itemType: item.itemType,
    title: item.title,
    url: item.url,
    author: item.author ?? null,
    description: item.description ?? null,
    topics: item.topics ?? [],
    metrics: item.metrics ?? {},
    capturedDate: date,
    capturedAt: now,
  }));
  if (rows.length === 0) return;
  await db()
    .insert(sourceItems)
    .values(rows)
    .onConflictDoUpdate({
      target: [sourceItems.source, sourceItems.sourceId, sourceItems.capturedDate],
      set: {
        itemType: sql`excluded.item_type`,
        title: sql`excluded.title`,
        url: sql`excluded.url`,
        author: sql`excluded.author`,
        description: sql`excluded.description`,
        topics: sql`excluded.topics`,
        metrics: sql`excluded.metrics`,
        capturedAt: sql`excluded.captured_at`,
      },
    });
}

export async function runSources(
  now: Date = new Date(),
  adapters: SourceAdapter[] = SOURCE_ADAPTERS,
): Promise<SourceRunResult[]> {
  const date = shanghaiToday(now);
  const results: SourceRunResult[] = [];

  for (const adapter of adapters) {
    try {
      const items = await adapter.fetch(now);
      await store(adapter.id, date, items, now);
      results.push({ id: adapter.id, label: adapter.label, count: items.length });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[sources] ${adapter.id} failed: ${error}`);
      results.push({ id: adapter.id, label: adapter.label, count: 0, error });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const results = await runSources();
  let total = 0;
  for (const result of results) {
    total += result.count;
    const status = result.error ? `ERROR ${result.error}` : `${result.count} 条`;
    console.log(`[sources] ${result.label} (${result.id}): ${status}`);
  }
  if (total === 0) {
    console.error('[sources] no items captured — exiting 1 to trigger alerting');
    process.exit(1);
  }
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
