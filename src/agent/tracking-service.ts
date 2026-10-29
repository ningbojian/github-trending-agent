import { and, eq } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache, trackedItems } from '../db/schema.js';
import { createGithubClient } from '../github/client.js';
import { nextCursor, parseTrackRequest, type ParsedTrackTarget } from './tracking.js';

/**
 * 跟踪的读写服务：命令层（微信）与面板（H5）共用。
 * 只负责 DB/GitHub；文案由各自调用方决定。
 */

export const MAX_TRACKED_ITEMS = 10;
const LIST_CACHE_PREFIX = 'tracking-list:v1:';
const LIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrackedRow {
  identifier: string;
  displayName: string;
  active: boolean;
  cursor: unknown;
  lastCheckedAt: Date | null;
}

export type AddTrackResult =
  | { ok: true; displayName: string; stars: number }
  | { ok: false; reason: 'usage' | 'limit' | 'not-found' | 'error' };

export async function listTracked(userid: string): Promise<TrackedRow[]> {
  const rows = (await db()
    .select()
    .from(trackedItems)
    .where(
      and(
        eq(trackedItems.wecomUserid, userid),
        eq(trackedItems.active, true),
      ),
    )) as Array<{
    identifier: string;
    displayName: string;
    active: boolean;
    cursor: unknown;
    lastCheckedAt: Date | null;
  }>;
  return rows;
}

/** 加入跟踪：校验仓库、按当前状态建基线、写库。 */
export async function addTrackedRepo(
  userid: string,
  input: string,
): Promise<AddTrackResult> {
  const target = parseTrackRequest(input);
  if (target === null) return { ok: false, reason: 'usage' };

  try {
    const existing = await listTracked(userid);
    if (existing.length >= MAX_TRACKED_ITEMS) {
      return { ok: false, reason: 'limit' };
    }

    const token = env.GITHUB_TOKEN ?? null;
    const client = createGithubClient();
    const [repoResult, releasesResult] = await Promise.all([
      client.getRepo({ owner: target.owner, name: target.name }, token),
      client.getReleases({ owner: target.owner, name: target.name }, token),
    ]);
    if (!repoResult.ok) return { ok: false, reason: 'not-found' };

    const now = new Date();
    const cursor = nextCursor(
      {},
      {
        repo: repoResult.data,
        releases: releasesResult.ok ? releasesResult.data : [],
      },
      now,
    );

    await db()
      .insert(trackedItems)
      .values({
        wecomUserid: userid,
        source: 'github',
        kind: 'repo',
        identifier: target.identifier,
        displayName: target.displayName,
        cursor,
        active: true,
        lastCheckedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          trackedItems.wecomUserid,
          trackedItems.source,
          trackedItems.kind,
          trackedItems.identifier,
        ],
        set: {
          displayName: target.displayName,
          cursor,
          active: true,
          lastCheckedAt: now,
        },
      });

    return { ok: true, displayName: target.displayName, stars: repoResult.data.stars };
  } catch (err) {
    console.error('addTrackedRepo failed:', err);
    return { ok: false, reason: 'error' };
  }
}

/** 取消跟踪（置 active=false）。identifier 已经是规范化的小写值。 */
export async function removeTracked(userid: string, identifier: string): Promise<void> {
  await db()
    .update(trackedItems)
    .set({ active: false })
    .where(
      and(
        eq(trackedItems.wecomUserid, userid),
        eq(trackedItems.identifier, identifier),
      ),
    );
}

/** 「我的追踪」写入的编号列表，供「取消追踪 N」与面板按钮使用。 */
export async function writeTrackList(
  userid: string,
  items: Array<{ identifier: string; displayName: string }>,
): Promise<void> {
  const expiresAt = new Date(Date.now() + LIST_CACHE_TTL_MS);
  await db()
    .insert(kvCache)
    .values({
      key: `${LIST_CACHE_PREFIX}${userid}`,
      value: { items },
      expiresAt,
    })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: { items }, expiresAt },
    });
}

export async function readTrackList(
  userid: string,
): Promise<Array<{ identifier: string; displayName: string }> | null> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(eq(kvCache.key, `${LIST_CACHE_PREFIX}${userid}`));
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const value = row.value as { items?: unknown } | null;
  if (!value || !Array.isArray(value.items)) return null;
  return value.items as Array<{ identifier: string; displayName: string }>;
}

export type { ParsedTrackTarget };
