/**
 * 「我的订阅」的排版（纯函数，不碰 DB/网络）。
 *
 * 默认值与清洗规则全部来自 preferences.ts，和推送门控共用一套——
 * 否则会出现「我的订阅说 09:00，实际按 10:00 推」的漂移。
 *
 * 展示用用户写入的**原始大小写**（AI 不显示成 ai），缺省值才回落到规范化结果。
 */

import { normalizePreferences, type PreferencesInput } from './preferences.js';
import type { SubscriptionPreferences } from './subscription-store.js';

/** 原始值里的字符串列表（展示用；脏数据 → 空数组）。 */
function rawList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

/**
 * 订阅摘要：状态 / 时间 / 条数 / 关键词 /（可选）语言过滤 + 一行改法提示。
 * active=false 时如实说明「已退订」并给出恢复入口。
 */
export function formatSubscriptionSummary(
  preferences: PreferencesInput | SubscriptionPreferences,
  active: boolean,
): string {
  const normalized = normalizePreferences(preferences);
  const languages = rawList(preferences.languages);
  const keywords = rawList(preferences.keywords);

  const timeLine =
    normalized.intervalDays > 1
      ? `· 时间：${normalized.pushTime}（北京时间），每 ${normalized.intervalDays} 天推一次`
      : `· 时间：每天 ${normalized.pushTime}（北京时间）`;

  const lines = [
    '你的订阅：',
    active ? '· 状态：已开通每日简报' : '· 状态：已退订（发「订阅 <偏好>」可恢复）',
    timeLine,
    `· 条数：每次最多 ${normalized.digestCount} 条`,
    keywords.length > 0
      ? `· 偏好关键词：${keywords.join('、')}`
      : '· 偏好关键词：未设置（按全站热榜推荐）',
  ];
  if (languages.length > 0) {
    lines.push(`· 语言过滤：${languages.join('、')}`);
  }
  lines.push('💡 改关键词发「订阅 <偏好>」；改条数/时间发「条数 N」「每天 H 点」');
  return lines.join('\n');
}
