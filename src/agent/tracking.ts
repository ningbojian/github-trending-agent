import type { TrackedCursor } from '../db/schema.js';
import type { ReleaseInfo, RepoInfo } from '../github/client.js';
import { parseRepoRef } from '../github/repo-ref.js';

/**
 * 跨源跟踪的纯逻辑（不碰 DB / 网络）。
 *
 * 与 GitHub Watch 的差异：Watch 把每个 issue/PR/release/star 都当通知；
 * 我们只在「实质变化」时说话——新 release、star 明显加速、仓库归档——
 * 且第一次检查只建基线，不把当前已有的 release 当成新闻。
 */

export interface ParsedTrackTarget {
  kind: 'repo';
  identifier: string;
  displayName: string;
  owner: string;
  name: string;
}

/** 解析用户丢进来的跟踪目标；目前只接受 GitHub 仓库（`owner/repo` 或链接）。 */
export function parseTrackRequest(text: string): ParsedTrackTarget | null {
  const ref = parseRepoRef(text.trim());
  if (ref === null) return null;
  const displayName = `${ref.owner}/${ref.name}`;
  return {
    kind: 'repo',
    identifier: displayName.toLowerCase(),
    displayName,
    owner: ref.owner,
    name: ref.name,
  };
}

export type TrackedChangeKind = 'release' | 'star-surge' | 'archived';

export interface TrackedChange {
  kind: TrackedChangeKind;
  /** 已在前面带上 `owner/repo：`，渲染层直接逐行输出。 */
  facts: string;
}

function latestStableRelease(releases: ReleaseInfo[]): ReleaseInfo | null {
  const stable = releases.filter((release) => !release.prerelease && release.tag.trim() !== '');
  if (stable.length === 0) return null;
  return stable.sort((a, b) => {
    const left = a.publishedAt ?? '';
    const right = b.publishedAt ?? '';
    return right.localeCompare(left);
  })[0] ?? null;
}

function daysBetween(from: string | undefined, to: string | null): number | null {
  if (from === undefined || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

/**
 * 判定值得通知的变化。空 cursor = 首次检查，返回空数组（只建基线）。
 * star 加速阈值：`max(50, 当前星标 5%)`，避免小仓库 3 个 star 也来打扰。
 */
export function computeTrackedChanges(
  cursor: TrackedCursor,
  snapshot: { repo: RepoInfo; releases: ReleaseInfo[] },
  now: Date = new Date(),
): TrackedChange[] {
  if (cursor.releaseTag === undefined && cursor.lastStars === undefined) {
    return [];
  }

  const { repo, releases } = snapshot;
  const changes: TrackedChange[] = [];

  const latest = latestStableRelease(releases);
  if (latest !== null && latest.tag !== cursor.releaseTag) {
    const newerThanCursor =
      cursor.releasePublishedAt === undefined ||
      latest.publishedAt === null ||
      latest.publishedAt > cursor.releasePublishedAt;
    if (newerThanCursor) {
      const days = daysBetween(cursor.releasePublishedAt, latest.publishedAt);
      changes.push({
        kind: 'release',
        facts: `${repo.fullName}：${latest.tag} 发布${
          days !== null ? `（距上个版本 ${days} 天）` : ''
        }`,
      });
    }
  }

  if (cursor.lastStars !== undefined) {
    const delta = repo.stars - cursor.lastStars;
    const threshold = Math.max(50, Math.round(repo.stars * 0.05));
    if (delta >= threshold) {
      changes.push({
        kind: 'star-surge',
        facts: `${repo.fullName}：24 小时星标 +${delta}（${cursor.lastStars} → ${repo.stars}）`,
      });
    }
  }

  if (repo.archived && cursor.archived !== true) {
    changes.push({
      kind: 'archived',
      facts: `${repo.fullName}：仓库已归档（只读）`,
    });
  }

  // now 目前只用于签名；保留参数让调用方显式传时钟，测试可复现。
  void now;
  return changes;
}

/** 推进 cursor：只在消息发送成功后调用；发送失败保留旧 cursor 以便重试。 */
export function nextCursor(
  cursor: TrackedCursor,
  snapshot: { repo: RepoInfo; releases: ReleaseInfo[] },
  now: Date = new Date(),
): TrackedCursor {
  const latest = latestStableRelease(snapshot.releases);
  return {
    ...cursor,
    releaseTag: latest?.tag ?? cursor.releaseTag,
    releasePublishedAt: latest?.publishedAt ?? cursor.releasePublishedAt,
    lastStars: snapshot.repo.stars,
    lastCheckedAt: now.toISOString(),
    archived: snapshot.repo.archived,
  };
}

/** 每日一条变化摘要；没有变化返回 null。 */
export function formatTrackedSummary(
  date: string,
  changes: TrackedChange[],
): string | null {
  if (changes.length === 0) return null;
  const header = `跟踪变化（${date.slice(5)}）`;
  const lines = changes.slice(0, 5).map((change, index) => `${index + 1}. ${change.facts}`);
  while (lines.length > 0) {
    const text = [header, ...lines].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= 1900) return text;
    lines.pop();
  }
  return null;
}
