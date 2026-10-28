import { and, eq } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { kvCache, trackedItems } from '../db/schema.js';
import { createGithubClient } from '../github/client.js';
import { nextCursor, parseTrackRequest } from '../agent/tracking.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「追踪 / 我的追踪 / 取消追踪」命令。
 *
 * 与 GitHub Watch 的差异：这里只登记「要关注什么」，真正的变化判定
 * 在每日检查里做（新 release / star 加速 / 归档），且第一次检查只建基线。
 */

export const MAX_TRACKED_ITEMS = 10;

export const TRACK_USAGE_REPLY =
  '用法：「追踪 owner/repo」或「追踪 https://github.com/owner/repo」，例如：追踪 astral-sh/ruff';
export const TRACK_LIMIT_REPLY = `最多同时跟踪 ${MAX_TRACKED_ITEMS} 个仓库；先发「我的追踪」取消一个。`;
export const TRACK_FAILURE_REPLY = '暂时读不到这个仓库，稍后再试。';
export const UNTRACK_USAGE_REPLY =
  '用法：「取消追踪 2」按序号取消，或「取消追踪 owner/repo」。';
export const MY_TRACKING_EMPTY_REPLY =
  '你还没有跟踪任何仓库。发「追踪 owner/repo」试试，例如：追踪 astral-sh/ruff';

const LIST_CACHE_PREFIX = 'tracking-list:v1:';
const LIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function trackArg(content: string): string {
  return content.trim().replace(/^(追踪|跟踪|关注)\s*/, '').trim();
}

function untrackArg(content: string): string {
  return content.trim().replace(/^取消(追踪|跟踪|关注)\s*/, '').trim();
}

/** 「我的追踪」写入的编号列表，供「取消追踪 N」解析。 */
async function writeTrackList(
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

async function readTrackList(
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

/** 「追踪 <GitHub 仓库>」：校验仓库、用当前状态建基线、落库。 */
export async function handleTrack(msg: InboundMessage): Promise<void> {
  const target = parseTrackRequest(trackArg(msg.content));
  if (target === null) {
    await sendWeComText(msg.fromUserName, TRACK_USAGE_REPLY);
    return;
  }

  try {
    const existing = (await db()
      .select()
      .from(trackedItems)
      .where(
        and(
          eq(trackedItems.wecomUserid, msg.fromUserName),
          eq(trackedItems.active, true),
        ),
      )) as Array<{ identifier: string }>;

    if (existing.length >= MAX_TRACKED_ITEMS) {
      await sendWeComText(msg.fromUserName, TRACK_LIMIT_REPLY);
      return;
    }

    const token = env.GITHUB_TOKEN ?? null;
    const client = createGithubClient();
    const [repoResult, releasesResult] = await Promise.all([
      client.getRepo({ owner: target.owner, name: target.name }, token),
      client.getReleases({ owner: target.owner, name: target.name }, token),
    ]);
    if (!repoResult.ok) {
      await sendWeComText(msg.fromUserName, TRACK_FAILURE_REPLY);
      return;
    }

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
        wecomUserid: msg.fromUserName,
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

    await sendWeComText(
      msg.fromUserName,
      `✅ 已跟踪 ${target.displayName}（当前 ★${repoResult.data.stars}）。有新 release 或 star 加速时，我会在每天的「跟踪变化」里告诉你。`,
    );
  } catch (err) {
    console.error('handleTrack failed:', err);
    await sendWeComText(msg.fromUserName, TRACK_FAILURE_REPLY);
  }
}

/** 「我的追踪」：列出编号，并缓存列表供按序号取消。 */
export async function handleMyTracking(msg: InboundMessage): Promise<void> {
  try {
    const rows = (await db()
      .select()
      .from(trackedItems)
      .where(
        and(
          eq(trackedItems.wecomUserid, msg.fromUserName),
          eq(trackedItems.active, true),
        ),
      )) as Array<{ identifier: string; displayName: string }>;

    if (rows.length === 0) {
      await sendWeComText(msg.fromUserName, MY_TRACKING_EMPTY_REPLY);
      return;
    }

    await writeTrackList(msg.fromUserName, rows);
    const lines = rows.map((row, index) => `${index + 1}. ${row.displayName}`);
    await sendWeComText(
      msg.fromUserName,
      ['你正在跟踪：', ...lines, '发「取消追踪 N」取消第 N 个。'].join('\n'),
    );
  } catch (err) {
    console.error('handleMyTracking failed:', err);
    await sendWeComText(msg.fromUserName, '读取跟踪列表失败，请稍后再试。');
  }
}

/** 「取消追踪 N / owner/repo」：置 active=false。 */
export async function handleUntrack(msg: InboundMessage): Promise<void> {
  const arg = untrackArg(msg.content);
  if (arg === '') {
    await sendWeComText(msg.fromUserName, UNTRACK_USAGE_REPLY);
    return;
  }

  try {
    let identifier: string | null = null;
    let displayName: string | null = null;

    if (/^\d+$/.test(arg)) {
      const list = await readTrackList(msg.fromUserName);
      const index = Number(arg) - 1;
      const item = list?.[index];
      if (!item) {
        await sendWeComText(msg.fromUserName, UNTRACK_USAGE_REPLY);
        return;
      }
      identifier = item.identifier;
      displayName = item.displayName;
    } else {
      const target = parseTrackRequest(arg);
      if (target === null) {
        await sendWeComText(msg.fromUserName, UNTRACK_USAGE_REPLY);
        return;
      }
      identifier = target.identifier;
      displayName = target.displayName;
    }

    await db()
      .update(trackedItems)
      .set({ active: false })
      .where(
        and(
          eq(trackedItems.wecomUserid, msg.fromUserName),
          eq(trackedItems.identifier, identifier),
        ),
      );

    // 列表缓存作废：用户下次发「我的追踪」会重建。
    await db()
      .update(kvCache)
      .set({ value: { items: [] }, expiresAt: new Date(0) })
      .where(eq(kvCache.key, `${LIST_CACHE_PREFIX}${msg.fromUserName}`));

    await sendWeComText(msg.fromUserName, `✅ 已取消跟踪 ${displayName}。`);
  } catch (err) {
    console.error('handleUntrack failed:', err);
    await sendWeComText(msg.fromUserName, '取消跟踪失败，请稍后再试。');
  }
}
