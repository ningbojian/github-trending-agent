import { SCRAPER_LANGUAGES } from '../config.js';

/**
 * 邮箱订阅者偏好：字段校验与默认值（设置页写入、推送读取共用）。
 * - pushTime：09:00–17:00 整点（与每小时 cron 对齐）
 * - intervalDays：1 / 2 / 3 / 7
 * - digestCount：5 / 10 / 15 / 20（默认 15；邮件不截断）
 * - languages：现有 18 个语言榜（小写）
 * - keywords：标点清洗、小写化、去重、最多 10 个
 */

export const EMAIL_DEFAULT_PUSH_TIME = '09:00';
export const EMAIL_DEFAULT_INTERVAL_DAYS = 1;
export const EMAIL_DEFAULT_DIGEST_COUNT = 15;
export const EMAIL_PUSH_TIMES = [
  '09:00',
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
] as const;
export const EMAIL_INTERVALS = [1, 2, 3, 7] as const;
export const EMAIL_DIGEST_COUNTS = [5, 10, 15, 20] as const;
export const EMAIL_MAX_KEYWORDS = 10;

export interface EmailPreferences {
  pushTime: string;
  intervalDays: number;
  digestCount: number;
  languages: string[];
  keywords: string[];
}

const KEYWORD_PUNCT_RE = /[。！？!?；;，,、()（）]/g;

export function normalizeEmailLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(SCRAPER_LANGUAGES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const language = String(item).trim().toLowerCase();
    if (!allowed.has(language) || seen.has(language)) continue;
    seen.add(language);
    out.push(language);
  }
  return out;
}

export function normalizeEmailKeywords(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、]/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const keyword = String(item)
      .replace(KEYWORD_PUNCT_RE, '')
      .trim()
      .toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
    if (out.length >= EMAIL_MAX_KEYWORDS) break;
  }
  return out;
}

/** 运行时读取兜底：脏数据一律回默认值。 */
export function normalizeEmailPreferences(value: unknown): EmailPreferences {
  const raw = (value && typeof value === 'object' ? value : {}) as {
    pushTime?: unknown;
    intervalDays?: unknown;
    digestCount?: unknown;
    languages?: unknown;
    keywords?: unknown;
  };
  // 与设置页写入校验共用同一份白名单：08:00 / 18:00 这类整点落在发送窗口外，
  // 放进来会让该订阅者永远收不到信，因此一律回默认 09:00。
  const pushTime =
    typeof raw.pushTime === 'string' &&
    (EMAIL_PUSH_TIMES as readonly string[]).includes(raw.pushTime)
      ? raw.pushTime
      : EMAIL_DEFAULT_PUSH_TIME;
  const intervalDays = (EMAIL_INTERVALS as readonly number[]).includes(Number(raw.intervalDays))
    ? Number(raw.intervalDays)
    : EMAIL_DEFAULT_INTERVAL_DAYS;
  const digestCount = (EMAIL_DIGEST_COUNTS as readonly number[]).includes(Number(raw.digestCount))
    ? Number(raw.digestCount)
    : EMAIL_DEFAULT_DIGEST_COUNT;
  return {
    pushTime,
    intervalDays,
    digestCount,
    languages: normalizeEmailLanguages(raw.languages),
    keywords: normalizeEmailKeywords(raw.keywords),
  };
}

/** 设置页写入校验：非法值返回字段级错误（不回显内部细节）。 */
export function validateEmailPreferencesInput(fields: {
  pushTime?: string;
  intervalDays?: string;
  digestCount?: string;
  languages?: string[];
  keywords?: string;
}): { ok: true; preferences: EmailPreferences } | { ok: false; error: string } {
  const pushTime = fields.pushTime ?? EMAIL_DEFAULT_PUSH_TIME;
  if (!(EMAIL_PUSH_TIMES as readonly string[]).includes(pushTime)) {
    return { ok: false, error: '推送时间必须是 09:00–17:00 的整点。' };
  }
  const intervalDays = Number(fields.intervalDays ?? EMAIL_DEFAULT_INTERVAL_DAYS);
  if (!(EMAIL_INTERVALS as readonly number[]).includes(intervalDays)) {
    return { ok: false, error: '推送间隔只能选每天 / 每 2 / 3 / 7 天。' };
  }
  const digestCount = Number(fields.digestCount ?? EMAIL_DEFAULT_DIGEST_COUNT);
  if (!(EMAIL_DIGEST_COUNTS as readonly number[]).includes(digestCount)) {
    return { ok: false, error: '简报条数只能选 5 / 10 / 15 / 20。' };
  }
  return {
    ok: true,
    preferences: {
      pushTime,
      intervalDays,
      digestCount,
      languages: normalizeEmailLanguages(fields.languages ?? []),
      keywords: normalizeEmailKeywords(fields.keywords ?? ''),
    },
  };
}
