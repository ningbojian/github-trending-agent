import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { kvCache } from '../src/db/schema.js';
import { normalizeQueryText } from '../src/agent/query-cache.js';
import type { Intent } from '../src/agent/intent.js';

/**
 * 从匿名意图日志里捞出「待人工标注」的候选。
 *
 * 日志只记规则层没学到的输入（`intent-miss:*`），而且只存归一化原话，
 * 所以这里做的事只有三件：去重、计数、按出现次数排序。**不产出金标**——
 * 正确答案必须人工判断；这个脚本只负责把最值得看的话排到最前面。
 *
 * 输出一律不带 userid：key 里本来就没有用户标识，只有日期与文本 hash。
 */

/** 一条待标注候选。 */
export interface SeedCandidate {
  text: string;
  /** 当时最终生效的意图（规则或模型判定结果）。 */
  final: Intent;
  /** 同一句话出现在多少个「天桶」里。 */
  count: number;
  /** 最近一次出现的日期（YYYY-MM-DD）。 */
  lastDay: string;
}

/** 日志行：只依赖 key/value，方便测试用假数据。 */
export interface IntentLogRow {
  key: string;
  value: unknown;
}

const KEY_PREFIX = 'intent-miss:';
const FINAL_INTENTS = new Set<Intent>(['search', 'about', 'off_topic']);

function parseRow(row: IntentLogRow): { text: string; final: Intent; day: string } | null {
  if (!row.key.startsWith(KEY_PREFIX)) return null;
  const [, rawDay] = row.key.split(':');
  if (rawDay === undefined || !/^\d{8}$/.test(rawDay)) return null;

  const value = row.value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = record.text;
  const final = record.final;
  if (typeof text !== 'string' || text.trim() === '') return null;
  if (typeof final !== 'string' || !FINAL_INTENTS.has(final as Intent)) return null;

  const day = `${rawDay.slice(0, 4)}-${rawDay.slice(4, 6)}-${rawDay.slice(6)}`;
  return { text, final: final as Intent, day };
}

/**
 * 纯函数聚合：同一句话跨天出现 → 合并计数，保留最近一天。
 * 排序：出现次数降序，同频按文本字典序（结果稳定，便于 diff）。
 */
export function groupCandidates(rows: IntentLogRow[]): SeedCandidate[] {
  const merged = new Map<string, SeedCandidate>();

  for (const row of rows) {
    const parsed = parseRow(row);
    if (parsed === null) continue;
    const key = normalizeQueryText(parsed.text);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        text: parsed.text,
        final: parsed.final,
        count: 1,
        lastDay: parsed.day,
      });
      continue;
    }
    existing.count += 1;
    if (parsed.day > existing.lastDay) {
      existing.lastDay = parsed.day;
      existing.final = parsed.final;
      existing.text = parsed.text;
    }
  }

  return [...merged.values()].sort(
    (a, b) => b.count - a.count || a.text.localeCompare(b.text, 'zh-Hans-CN'),
  );
}

/** 读全量意图日志（只读；失败直接抛，调用方决定是否忽略）。 */
export async function loadIntentLogRows(limit = 5000): Promise<IntentLogRow[]> {
  const rows = await db()
    .select({ key: kvCache.key, value: kvCache.value })
    .from(kvCache)
    .where(sql`${kvCache.key} like ${`${KEY_PREFIX}%`}`)
    .limit(limit);
  return rows;
}

/** 命令行入口：打印 JSONL 候选（每行一条，方便直接贴进标注表格）。 */
async function main(): Promise<void> {
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg === undefined ? 50 : Number.parseInt(limitArg.slice(8), 10);
  const rows = await loadIntentLogRows();
  const candidates = groupCandidates(rows).slice(
    0,
    Number.isFinite(limit) && limit > 0 ? limit : 50,
  );
  for (const candidate of candidates) {
    process.stdout.write(`${JSON.stringify(candidate)}\n`);
  }
  process.stderr.write(
    `共 ${candidates.length} 条候选（来自 ${rows.length} 行日志）。标注后手写进 evals/golden/*.jsonl。\n`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `读取意图日志失败：${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
  });
}
