import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { displayWidth } from '../text-width.js';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { generateObjectSafe, type LlmChoice } from './llm.js';

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

/** 卡片标题专用的短句：完整短语，≤18 个汉字。 */
const shortSchema = z.object({
  summaries: z.array(z.object({ fullName: z.string(), short: z.string() })),
});

/** 短句的显示宽度上限（汉字 2 列；标题里只剩约 20 列）。 */
const SHORT_MAX_WIDTH = 40;

interface CacheValue {
  zh: string;
  src: string;
}

interface ShortCacheValue {
  short: string;
  src: string;
}

interface CacheWrite {
  key: string;
  value: Record<string, unknown>;
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
 *
 * `choice` 决定用谁的模型：默认运营方（每日推送）；互动传 `{ kind: 'none' }`
 * 表示用户没配 Key —— 此时**只读**共享缓存，不调模型也不写缓存，
 * 未命中退回 description 截断，运营方与用户的额度都不花。
 */
export async function loadRepoSummaries(
  items: SummaryInput[],
  choice: LlmChoice = { kind: 'operator' },
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

  // 用户没配 Key：不调模型、不写缓存，未命中直接退回 description 截断。
  if (choice.kind === 'none') {
    for (const item of misses) {
      const zh = item.description && isChinese(item.description)
        ? truncateChars(item.description, ZH_MAX_CHARS)
        : fallbackZh(item.description);
      if (zh !== null) result.set(item.fullName, zh);
    }
    return result;
  }

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
      // 运营方路径保持两参调用（既有测试与诊断记录的入参形状不变）。
      out =
        choice.kind === 'user'
          ? await generateObjectSafe(summariesSchema, buildPrompt(llmTargets), choice.config)
          : await generateObjectSafe(summariesSchema, buildPrompt(llmTargets));
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

// ---------------------------------------------------------------------------
// 短简介（news 卡片标题用）
// ---------------------------------------------------------------------------

/**
 * 卡片标题只剩约 40 列（18 个汉字），把 28 字简介硬截会得到半句话——
 * 用户明确说过「截了一半，不好」。这里让模型单独生成一个**完整短语**，
 * 缓存在独立的 `repo-short:` 键下（src = 完整简介，简介变了就失效）。
 *
 * 拿不到（LLM 失败/超宽/没配 Key）就不返回——渲染层会退回完整分句，
 * 再不行干脆不写简介。绝不把长句切一半塞进标题。
 */

const SHORT_CACHE_PREFIX = 'repo-short:v3:';

/** 单批仓库数：一次塞太多会让网关超时（2026-10-28 实测 60 条直接 abort）。 */
const SHORT_BATCH_SIZE = 10;

function shortCacheKey(fullName: string): string {
  return `${SHORT_CACHE_PREFIX}${fullName}`;
}

/** 去掉首尾空白、引号与结尾标点/省略号。 */
function cleanShortText(text: string): string {
  return text
    .trim()
    .replace(/^[「『“"'（(]+/, '')
    .replace(/[，。；：、,.;:!?！？…「」『』“”"'）)]+$/u, '')
    .trim();
}

/** 超宽就返回空串（不硬切）。 */
function normalizeShortText(text: string): string {
  const cleaned = cleanShortText(text);
  if (cleaned === '') return '';
  return displayWidth(cleaned) <= SHORT_MAX_WIDTH ? cleaned : '';
}

function buildShortPrompt(items: ShortSummaryInput[]): string {
  return [
    '把下列 GitHub 仓库压成一个更短的中文短语，要求：',
    '1. 说清楚它能帮用户**完成什么**（动作 + 结果），写成一句完整的话，不要只写「XX 工具 / 框架 / 平台」；',
    '   例：「跨平台内容搜索工具」应写成「跨平台搜内容并汇总」；',
    '2. 不超过 18 个汉字，必须是一句完整的话，不加省略号，不要半句话；',
    '3. 不评价、不夸张、不编造资料里没有的功能；',
    '4. 每个仓库恰好输出一条；',
    '5. 以 JSON 输出：{"summaries":[{"fullName":"owner/repo","short":"短语"}]}。',
    '',
    '仓库与资料：',
    ...items.map((item) => {
      const description = item.description?.trim();
      const topics =
        item.topics && item.topics.length > 0 ? `；topics: ${item.topics.join(', ')}` : '';
      return `- ${item.fullName}：${item.zh}${description ? `；description: ${description}` : ''}${topics}`;
    }),
  ].join('\n');
}

export interface ShortSummaryInput {
  fullName: string;
  zh: string;
  /** 原始 description/topics：短句要写「能做什么」，只靠 28 字概括常常只剩类别。 */
  description?: string | null;
  topics?: string[];
}

/** 缓存失效依据：简介或原始描述变了都该重新生成。 */
function shortSrc(item: ShortSummaryInput): string {
  return `${item.zh}|${item.description ?? ''}`;
}

/**
 * 批量加载卡片短句；key 与输入 fullName 对齐。
 * 只返回「完整且不超宽」的短语；缺失的由调用方决定退化成什么。
 */
export async function loadRepoShortSummaries(
  items: ShortSummaryInput[],
  choice: LlmChoice = { kind: 'operator' },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;

  const unique = [...new Map(items.map((item) => [item.fullName, item])).values()];
  const now = Date.now();

  const rows = await db()
    .select()
    .from(kvCache)
    .where(
      inArray(
        kvCache.key,
        unique.map((item) => shortCacheKey(item.fullName)),
      ),
    );

  const cached = new Map<string, ShortCacheValue>();
  for (const row of rows) {
    if (new Date(row.expiresAt).getTime() <= now) continue;
    const value = row.value as Partial<ShortCacheValue> | null;
    if (value && typeof value.short === 'string' && typeof value.src === 'string') {
      cached.set(row.key, { short: value.short, src: value.src });
    }
  }

  const misses: ShortSummaryInput[] = [];
  for (const item of unique) {
    const hit = cached.get(shortCacheKey(item.fullName));
    if (hit && hit.src === shortSrc(item)) {
      const normalized = normalizeShortText(hit.short);
      if (normalized !== '') {
        result.set(item.fullName, normalized);
        continue;
      }
    }
    misses.push(item);
  }
  if (misses.length === 0) return result;

  // 没配 Key 的互动路径：只读缓存，不调模型。
  if (choice.kind === 'none') return result;

  // 分批**并行**：一次塞 60 条会让 prompt/输出过大直接超时；串行 6 批又会
  // 超过 Cloudflare 的 100 秒源站超时（实测 524）。每批独立，单批失败只影响自己。
  const batches: ShortSummaryInput[][] = [];
  for (let start = 0; start < misses.length; start += SHORT_BATCH_SIZE) {
    batches.push(misses.slice(start, start + SHORT_BATCH_SIZE));
  }

  const writes: CacheWrite[] = [];
  const finished = await Promise.all(
    batches.map(async (batch) => {
      try {
        const prompt = buildShortPrompt(batch);
        const out =
          choice.kind === 'user'
            ? await generateObjectSafe(shortSchema, prompt, choice.config)
            : await generateObjectSafe(shortSchema, prompt);
        return { batch, out };
      } catch {
        return { batch, out: null };
      }
    }),
  );

  for (const { batch, out } of finished) {
    if (out === null) continue;
    const wanted = new Map(batch.map((item) => [item.fullName, item]));
    for (const entry of out.summaries) {
      const source = wanted.get(entry.fullName);
      if (source === undefined) continue; // 防御：丢弃未请求的仓库
      const short = normalizeShortText(entry.short);
      if (short === '') continue;
      result.set(entry.fullName, short);
      writes.push({
        key: shortCacheKey(entry.fullName),
        value: { short, src: shortSrc(source) },
        expiresAt: new Date(now + LONG_TTL_MS),
      });
    }
  }

  await writeCache(writes);
  return result;
}
