import { getCache } from '@vercel/functions';
import {
  anyDigestDue,
  readDueSnapshot,
  type DueSnapshot,
  type DueWindow,
} from './digest-due.js';
import { shanghaiMinutes, shanghaiToday } from './time.js';

/**
 * cron 的 due 状态缓存。
 *
 * 目标：48 次/天的 tick 里，绝大多数「没人到点」的请求不碰 Neon。
 * 缓存里只放「今天可能到点」的保守窗口（无 userid/邮箱），
 * 是否真的发送仍由 readDueSnapshot / anyDigestDue 查库裁决。
 *
 * 失效策略：订阅/发送状态变更时 expireTag，让下一次 tick 重建；
 * 超过 2 小时未刷新视为 miss，兜底漏掉的失效调用。
 */

export const DUE_STATE_TAG = 'digest-due-state';
export const DUE_STATE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const DUE_STATE_TTL_SECONDS = 26 * 60 * 60;

const DUE_STATE_VERSION = 1 as const;
const CACHE_NAMESPACE = 'gte';

export interface DueState {
  version: typeof DUE_STATE_VERSION;
  /** 北京时间日期 YYYY-MM-DD。 */
  date: string;
  /** 构建时间（ISO）。 */
  generatedAt: string;
  windows: DueWindow[];
}

export type DueCacheStatus = 'hit' | 'miss' | 'off';

export interface DueProbe {
  /** 现在是否真的有人到点。 */
  due: boolean;
  /** 本次是否查了库（缓存命中且不在窗口时为 false）。 */
  checked: boolean;
  cache: DueCacheStatus;
  /** 当前 tick 是否落在缓存窗口内。 */
  window: boolean;
}

function cacheKey(date: string): string {
  return `due-state:v${DUE_STATE_VERSION}:${date}`;
}

function cache() {
  return getCache({ namespace: CACHE_NAMESPACE });
}

function warn(message: string, err: unknown): void {
  if (process.env.NODE_ENV === 'test') return;
  console.warn(message, err instanceof Error ? err.message : err);
}

function isValidState(value: unknown, now: Date): value is DueState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<DueState>;
  if (state.version !== DUE_STATE_VERSION) return false;
  if (state.date !== shanghaiToday(now)) return false;
  if (typeof state.generatedAt !== 'string') return false;
  const generatedAt = Date.parse(state.generatedAt);
  if (!Number.isFinite(generatedAt)) return false;
  if (now.getTime() - generatedAt > DUE_STATE_MAX_AGE_MS) return false;
  if (!Array.isArray(state.windows)) return false;
  return state.windows.every(
    (window) =>
      window !== null &&
      typeof window === 'object' &&
      Number.isInteger(window.start) &&
      Number.isInteger(window.end) &&
      window.start >= 0 &&
      window.end <= 24 * 60 &&
      window.start <= window.end,
  );
}

export function isInDueWindow(state: DueState, now: Date): boolean {
  const minutes = shanghaiMinutes(now);
  return state.windows.some(
    (window) => minutes >= window.start && minutes < window.end,
  );
}

function stateFromSnapshot(now: Date, snapshot: DueSnapshot): DueState {
  return {
    version: DUE_STATE_VERSION,
    date: shanghaiToday(now),
    generatedAt: now.toISOString(),
    windows: snapshot.windows,
  };
}

async function readCachedState(
  now: Date,
): Promise<{ state: DueState | null; status: DueCacheStatus }> {
  try {
    const value = await cache().get(cacheKey(shanghaiToday(now)));
    if (isValidState(value, now)) return { state: value, status: 'hit' };
    return { state: null, status: 'miss' };
  } catch (err) {
    warn('due-state cache read failed:', err);
    return { state: null, status: 'off' };
  }
}

async function writeDueState(state: DueState): Promise<void> {
  try {
    await cache().set(cacheKey(state.date), state, {
      ttl: DUE_STATE_TTL_SECONDS,
      tags: [DUE_STATE_TAG],
      name: 'digest-due-state',
    });
  } catch (err) {
    // 写失败不影响本次判定；下一次 tick 会重新构建。
    warn('due-state cache write failed:', err);
  }
}

async function buildAndCache(
  now: Date,
): Promise<{ state: DueState; dueNow: boolean }> {
  const snapshot = await readDueSnapshot(now);
  const state = stateFromSnapshot(now, snapshot);
  await writeDueState(state);
  return { state, dueNow: snapshot.dueNow };
}

/** 订阅/发送状态变更后调用：让下一次 tick 重建，不在写路径额外查库。 */
export async function invalidateDueState(): Promise<void> {
  try {
    await cache().expireTag(DUE_STATE_TAG);
  } catch (err) {
    warn('due-state invalidate failed:', err);
  }
}

/** 发送完成后刷新，让窗口立即反映最新的 lastSentAt/lastDigestAt。 */
export async function refreshDueState(now: Date = new Date()): Promise<void> {
  try {
    await buildAndCache(now);
  } catch (err) {
    warn('due-state refresh failed:', err);
  }
}

/**
 * cron 的前置探针：
 * - 命中且不在窗口 → 不查库；
 * - 命中且在窗口 → 查库做最终裁决；
 * - 未命中/过期 → 查一次库并回填缓存；
 * - 缓存不可用 → 回落 anyDigestDue（fail-open）。
 */
export async function probeDue(now: Date = new Date()): Promise<DueProbe> {
  const loaded = await readCachedState(now);

  if (loaded.status === 'off') {
    return {
      due: await anyDigestDue(now),
      checked: true,
      cache: 'off',
      window: false,
    };
  }

  if (loaded.state) {
    const window = isInDueWindow(loaded.state, now);
    if (!window) {
      return { due: false, checked: false, cache: 'hit', window: false };
    }
    try {
      const snapshot = await readDueSnapshot(now);
      if (!snapshot.dueNow) {
        // 窗口是保守超集，库里已经没人到点：顺手收紧，避免后续 tick 反复查库。
        await writeDueState(stateFromSnapshot(now, snapshot));
      }
      return { due: snapshot.dueNow, checked: true, cache: 'hit', window: true };
    } catch (err) {
      warn('due-state recheck failed, falling back to anyDigestDue:', err);
      return {
        due: await anyDigestDue(now),
        checked: true,
        cache: 'hit',
        window: true,
      };
    }
  }

  try {
    const { state, dueNow } = await buildAndCache(now);
    return {
      due: dueNow,
      checked: true,
      cache: 'miss',
      window: isInDueWindow(state, now),
    };
  } catch (err) {
    warn('due-state rebuild failed, falling back to anyDigestDue:', err);
    return {
      due: await anyDigestDue(now),
      checked: true,
      cache: 'miss',
      window: false,
    };
  }
}
