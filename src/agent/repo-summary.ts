import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { generateObjectSafe } from './llm.js';

/**
 * 仓库中文简介（全局 kv 缓存 + 批量 LLM + 失败降级）。
 *
 * - 缓存：kv_cache key `repo-zh:<fullName>`，value `{ zh, src }`（src 存原
 *   description，变更即失效），TTL 180 天，跨用户共享。
 * - 命中条件：expiresAt > now 且 src === 当前 description（null 记为 ''）。
 * - 未命中合并为**一次**批量 generateObjectSafe；已是中文（CJK 占非空白字符
 *   ≥30%）的 description 不进 LLM，直接截断 28 字。
 * - LLM 失败 / REPO_SUMMARY_MODE=off：降级 description 按词边界截断 40 字符（含省略号），
 *   写缓存仅 1 天短 TTL（下次再试）；无 description 的条目不入 Map、不写缓存。
 */

export interface SummaryInput {
  fullName: string;
  description: string | null;
  topics?: string[];
}

const CACHE_PREFIX = 'repo-zh:';
/** 正常生成的简介缓存 180 天。 */
const LONG_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 降级（LLM 失败 / off 模式）结果只缓存 1 天，便于尽快重试。 */
const SHORT_TTL_MS = 24 * 60 * 60 * 1000;
/** 中文简介上限（汉字数）。 */
const ZH_MAX_CHARS = 28;
/** 降级时 description 截断长度（字符）。 */
const FALLBACK_MAX_CHARS = 40;

const summariesSchema = z.object({
  summaries: z.array(z.object({ fullName: z.string(), zh: z.string() })),
});

interface CacheValue {
  zh: string;
  src: string;
}

interface CacheWrite {
  key: string;
  value: CacheValue;
  expiresAt: Date;
}

function cacheKey(fullName: string): string {
  return `${CACHE_PREFIX}${fullName}`;
}

/** description 为 null 时以空串参与 src 比较与缓存。 */
function srcOf(description: string | null): string {
  return description ?? '';
}

/** CJK 字符占非空白字符 ≥ 30% 视为中文，不进 LLM。 */
function isChinese(text: string): boolean {
  const chars = Array.from(text).filter((c) => !/\s/.test(c));
  if (chars.length === 0) return false;
  // 显式 \u 转义：字面字符易错（曾把起点写成 U+8C48「豈」，误吞韩文/谚文等）。
  const cjk = chars.filter((c) =>
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c),
  ).length;
  return cjk / chars.length >= 0.3;
}

/** 按 Unicode 码位截断（避免拆散代理对）。 */
function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * 降级截断：英文描述按**词边界**截到 max 字以内并加省略号，
 * 避免出现「lazie」「fle」这类被切掉尾巴的半个单词。
 * 末尾留 1 位给省略号；找不到合适的空格时退回硬截断。
 */
function truncateWords(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const base = space > 0 ? cut.slice(0, space) : cut;
  return `${base.trimEnd()}…`;
}

/** 降级文案：description 按词边界截断 40 字符（含省略号）；无 description 返回 null（不入 Map、不写缓存）。 */
function fallbackZh(description: string | null): string | null {
  return description ? truncateWords(description, FALLBACK_MAX_CHARS) : null;
}

function cacheWrite(
  item: SummaryInput,
  zh: string,
  expiresAtMs: number,
): CacheWrite {
  return {
    key: cacheKey(item.fullName),
    value: { zh, src: srcOf(item.description) },
    expiresAt: new Date(expiresAtMs),
  };
}

/** 批量 upsert kv_cache（多行插入，冲突时覆盖 value 与 expires_at）。 */
async function writeCache(entries: CacheWrite[]): Promise<void> {
  if (entries.length === 0) return;
  await db()
    .insert(kvCache)
    .values(
      entries.map((e) => ({
        key: e.key,
        value: e.value,
        expiresAt: e.expiresAt,
      })),
    )
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
    });
}

function buildPrompt(items: SummaryInput[]): string {
  const lines = items.map((item) => {
    const desc = item.description?.trim() || '（无描述）';
    const topics =
      item.topics && item.topics.length > 0
        ? `；topics: ${item.topics.join(', ')}`
        : '';
    return `- ${item.fullName}：${desc}${topics}`;
  });
  return [
    '为下列每个 GitHub 仓库写一句中文简介，要求：',
    '1. 只说明仓库主要做什么，不评价、不夸张、不编造不存在的功能；',
    `2. 不超过 ${ZH_MAX_CHARS} 个汉字；`,
    '3. description 为空的仓库，根据 topics 和仓库名推断；',
    '4. 每个仓库恰好输出一条；',
    '5. 以 JSON 输出：{"summaries":[{"fullName":"owner/repo","zh":"简介"}]}。',
    '',
    '仓库列表：',
    ...lines,
  ].join('\n');
}

/**
 * 批量加载仓库中文简介；key 与输入 fullName 对齐。
 * 无 description 且无法生成的条目不出现在返回 Map 中。
 * 空输入直接返回空 Map（零查询）。
 */
export async function loadRepoSummaries(
  items: SummaryInput[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;

  // 按 fullName 去重（重复输入以最后一次为准）。
  const unique = [...new Map(items.map((i) => [i.fullName, i])).values()];
  const now = Date.now();

  // 1) kv_cache 批量命中（inArray 一次查询，只取未过期行）。
  const rows = await db()
    .select()
    .from(kvCache)
    .where(
      inArray(
        kvCache.key,
        unique.map((i) => cacheKey(i.fullName)),
      ),
    );

  const cached = new Map<string, CacheValue>();
  for (const row of rows) {
    if (new Date(row.expiresAt).getTime() <= now) continue;
    const value = row.value as Partial<CacheValue> | null;
    if (value && typeof value.zh === 'string' && typeof value.src === 'string') {
      cached.set(row.key, { zh: value.zh, src: value.src });
    }
  }

  const misses: SummaryInput[] = [];
  for (const item of unique) {
    const hit = cached.get(cacheKey(item.fullName));
    if (hit && hit.src === srcOf(item.description)) {
      result.set(item.fullName, hit.zh);
    } else {
      misses.push(item);
    }
  }
  if (misses.length === 0) return result;

  // 2) 中文 description 直接截断 28 字（不进 LLM），长 TTL 写缓存。
  const writes: CacheWrite[] = [];
  const llmTargets: SummaryInput[] = [];
  for (const item of misses) {
    if (item.description && isChinese(item.description)) {
      const zh = truncateChars(item.description, ZH_MAX_CHARS);
      result.set(item.fullName, zh);
      writes.push(cacheWrite(item, zh, now + LONG_TTL_MS));
    } else {
      llmTargets.push(item);
    }
  }

  // 3) 剩余未命中：off 模式零 LLM；否则合并为一次批量 generateObjectSafe。
  let generated = new Map<string, string>();
  if (llmTargets.length > 0 && env.REPO_SUMMARY_MODE !== 'off') {
    let out: z.infer<typeof summariesSchema> | null = null;
    try {
      out = await generateObjectSafe(summariesSchema, buildPrompt(llmTargets));
    } catch {
      out = null;
    }
    if (out) {
      const wanted = new Set(llmTargets.map((i) => i.fullName));
      for (const s of out.summaries) {
        // 防御：LLM 返回未请求的 fullName 时丢弃。
        if (wanted.has(s.fullName)) generated.set(s.fullName, s.zh);
      }
    }
  }

  // 4) LLM 结果 → 长 TTL；缺失/降级 → description 截断 40 字符 + 1 天短 TTL。
  for (const item of llmTargets) {
    const zh = generated.get(item.fullName);
    if (zh !== undefined) {
      result.set(item.fullName, zh);
      writes.push(cacheWrite(item, zh, now + LONG_TTL_MS));
    } else {
      const fb = fallbackZh(item.description);
      if (fb === null) continue;
      result.set(item.fullName, fb);
      writes.push(cacheWrite(item, fb, now + SHORT_TTL_MS));
    }
  }

  await writeCache(writes);
  return result;
}
