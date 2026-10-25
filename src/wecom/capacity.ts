import { sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import { getWeComAccessToken } from './api.js';

/**
 * 企微成员名额探测（best-effort）。
 * - `user/simplelist` 统计应用可见范围内、部门 1 及子部门的成员数；
 *   需要通讯录读取权限，失败一律返回 null（页面回退手动开关）。
 * - 结果缓存在 kv_cache 1 小时；cron 每小时可强制刷新。
 */

const CACHE_KEY = 'wecom_member_count';
const CACHE_TTL_MS = 60 * 60 * 1000;
/** 未认证企业成员名额默认上限。 */
export const DEFAULT_MEMBER_LIMIT = 100;

interface SimpleListResponse {
  errcode?: number;
  errmsg?: string;
  userlist?: Array<{ userid?: string }>;
}

/** WECOM_MEMBER_LIMIT 解析：正整数，否则 100。 */
export function weComMemberLimit(): number {
  const raw = env.WECOM_MEMBER_LIMIT;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MEMBER_LIMIT;
}

async function readCachedCount(): Promise<number | null> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(sql`${kvCache.key} = ${CACHE_KEY}`);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const value = row.value as { count?: unknown };
  return typeof value.count === 'number' ? value.count : null;
}

/** 探测超时：cron 每小时在推送前调用，接口卡死不能拖住整轮推送。 */
const PROBE_TIMEOUT_MS = 5000;

async function fetchMemberCount(): Promise<number> {
  const token = await getWeComAccessToken();
  const url =
    'https://qyapi.weixin.qq.com/cgi-bin/user/simplelist' +
    `?access_token=${encodeURIComponent(token)}` +
    '&department_id=1&fetch_child=1';
  const res = await fetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`user/simplelist HTTP ${res.status}`);
  }
  const body = (await res.json()) as SimpleListResponse;
  if (body.errcode !== 0 || !Array.isArray(body.userlist)) {
    throw new Error(
      `user/simplelist failed: errcode=${body.errcode} ${body.errmsg ?? ''}`,
    );
  }
  return body.userlist.length;
}

/**
 * 读取成员数：缓存 → 接口。任何失败返回 null（调用方回退手动开关）。
 * `force` 为 true 时跳过缓存读取（cron 每小时刷新用）。
 */
export async function getWeComMemberCount(
  options: { force?: boolean } = {},
): Promise<number | null> {
  try {
    if (!options.force) {
      const cached = await readCachedCount();
      if (cached !== null) return cached;
    }
    const count = await fetchMemberCount();
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
    try {
      await db()
        .insert(kvCache)
        .values({ key: CACHE_KEY, value: { count }, expiresAt })
        .onConflictDoUpdate({
          target: kvCache.key,
          set: { value: { count }, expiresAt },
        });
    } catch (err) {
      // 缓存写失败不影响返回值（最多下次再探测）。
      console.error('wecom member count cache write failed:', err);
    }
    return count;
  } catch (err) {
    console.error('getWeComMemberCount failed (fallback to manual switch):', err);
    return null;
  }
}

/** 强制刷新成员数缓存（cron 每小时调用）。 */
export async function refreshWeComMemberCount(): Promise<number | null> {
  return getWeComMemberCount({ force: true });
}

/**
 * 是否还接受新的企微成员：显式 `WECOM_ACCEPTING` > 探测值（count < 上限）> true。
 * 探测失败 → true（页面照常工作，成员数由企微后台兜底）。
 */
export async function isWeComAccepting(): Promise<boolean> {
  const explicit = env.WECOM_ACCEPTING?.trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  const count = await getWeComMemberCount();
  if (count === null) return true;
  return count < weComMemberLimit();
}
