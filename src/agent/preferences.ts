/**
 * 订阅偏好（subscribers.preferences）的唯一规范化入口。
 *
 * 为什么单独一个文件：读取侧（推送门控、简报构建）与展示侧（「我的订阅」）
 * 必须用同一套默认值和同一套清洗规则，否则「我的订阅」显示 09:00、
 * 实际按 10:00 推送——两处各写一遍迟早会漂。
 *
 * 全部是纯函数/常量：不碰 DB、不读 env。
 */

/** 简报默认条数（用户未设置 digestCount 时）。8 = 企微 news 一条的上限。 */
export const DEFAULT_DIGEST_COUNT = 8;
/** 简报条数下限（「条数 N」指令在 handler 层拦截 0/负数；此处 clamp 兜底脏数据）。 */
export const MIN_DIGEST_COUNT = 1;
/** 简报条数上限：企微 news 一条最多 8 篇，多一条整条消息会被 45008 拒绝。 */
export const MAX_DIGEST_COUNT = 8;
/** 简报默认推送时间（北京时间 HH:MM）。 */
export const DEFAULT_PUSH_TIME = '09:00';
/** 推送间隔下限（天）。 */
export const MIN_INTERVAL_DAYS = 1;
/** 推送间隔上限（天，成本护栏）。 */
export const MAX_INTERVAL_DAYS = 30;

/** pushTime 合法形态：24 小时制「HH:MM」（00:00–23:59）。 */
export const PUSH_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 偏好分隔/清洗用标点（与 parse-query 同一字符集）。 */
const KEYWORD_PUNCT_RE = /[。！？!?；;，,、()（）]/g;

/** 读取侧接受的原始形状（jsonb，字段可缺失或为脏值）。 */
export interface PreferencesInput {
  languages?: unknown;
  keywords?: unknown;
  digestCount?: unknown;
  pushTime?: unknown;
  intervalDays?: unknown;
}

/** 规范化后的偏好：所有字段都有确定值。 */
export interface NormalizedPreferences {
  languages: string[];
  keywords: string[];
  digestCount: number;
  pushTime: string;
  intervalDays: number;
}

/**
 * preferences 运行时防御：字段缺失/非数组一律按空处理（languages 空 → 全量）；
 * keywords 去中英文标点后 trim/lowercase（读取侧清洗存量脏数据，逻辑与 parse-query 一致）；
 * languages 只 trim/lowercase（语言过滤逻辑不变）；
 * digestCount 非有限数字（含字符串/NaN/缺失）→ 默认 8，有限数字 → clamp 1–8；
 * pushTime 不匹配 `^([01]\d|2[0-3]):[0-5]\d$` → 默认 09:00；
 * intervalDays 非 1–30 整数 → 默认 1（Handler写入侧已拦截越界，此处兜底脏数据）。
 */
export function normalizePreferences(preferences: PreferencesInput): NormalizedPreferences {
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : [];
  const keywordList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => String(item).replace(KEYWORD_PUNCT_RE, '').trim().toLowerCase())
          .filter(Boolean)
      : [];
  const rawCount = preferences.digestCount;
  const digestCount =
    typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.min(MAX_DIGEST_COUNT, Math.max(MIN_DIGEST_COUNT, Math.floor(rawCount)))
      : DEFAULT_DIGEST_COUNT;
  const rawPushTime = preferences.pushTime;
  const pushTime =
    typeof rawPushTime === 'string' && PUSH_TIME_RE.test(rawPushTime)
      ? rawPushTime
      : DEFAULT_PUSH_TIME;
  const rawInterval = preferences.intervalDays;
  const intervalDays =
    typeof rawInterval === 'number' &&
    Number.isInteger(rawInterval) &&
    rawInterval >= MIN_INTERVAL_DAYS &&
    rawInterval <= MAX_INTERVAL_DAYS
      ? rawInterval
      : 1;
  return {
    languages: list(preferences.languages),
    keywords: keywordList(preferences.keywords),
    digestCount,
    pushTime,
    intervalDays,
  };
}
