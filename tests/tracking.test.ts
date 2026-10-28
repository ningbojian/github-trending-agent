import { describe, expect, it } from 'vitest';
import {
  computeTrackedChanges,
  formatTrackedSummary,
  parseTrackRequest,
  type TrackedChange,
} from '../src/agent/tracking';
import type { ReleaseInfo, RepoInfo } from '../src/github/client';
import type { TrackedCursor } from '../src/db/schema';

/**
 * 跟踪的纯逻辑：解析用户丢进来的链接、判定「值得通知的变化」。
 *
 * 与 GitHub Watch 的差异就在这里：Watch 每个事件都推；我们只在
 * 新 release、star 明显加速、仓库归档时说话，并且第一次检查只建基线，
 * 不会把「当前已有的 release」当成新闻。
 */

const NOW = new Date('2026-10-29T01:00:00Z');

function repo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    fullName: 'acme/rocket',
    description: null,
    language: 'TypeScript',
    stars: 1200,
    forks: 10,
    openIssues: 1,
    pushedAt: '2026-10-28T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z',
    archived: false,
    license: null,
    topics: [],
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/acme/rocket',
    ...overrides,
  };
}

function release(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag: 'v1.2.0',
    name: 'v1.2.0',
    publishedAt: '2026-10-20T00:00:00Z',
    prerelease: false,
    ...overrides,
  };
}

describe('parseTrackRequest', () => {
  it('接受 owner/repo 与 GitHub 链接', () => {
    expect(parseTrackRequest('astral-sh/ruff')).toEqual({
      kind: 'repo',
      identifier: 'astral-sh/ruff',
      displayName: 'astral-sh/ruff',
      owner: 'astral-sh',
      name: 'ruff',
    });
    expect(parseTrackRequest('https://github.com/astral-sh/ruff')).toEqual({
      kind: 'repo',
      identifier: 'astral-sh/ruff',
      displayName: 'astral-sh/ruff',
      owner: 'astral-sh',
      name: 'ruff',
    });
  });

  it('大小写规范化：identifier 小写，displayName 保留原样', () => {
    const parsed = parseTrackRequest('Astral-Sh/Ruff');
    expect(parsed?.identifier).toBe('astral-sh/ruff');
    expect(parsed?.displayName).toBe('Astral-Sh/Ruff');
  });

  it('拒绝非 GitHub 链接与无法识别的文本', () => {
    expect(parseTrackRequest('https://huggingface.co/org/model')).toBeNull();
    expect(parseTrackRequest('随便一句话')).toBeNull();
    expect(parseTrackRequest('astral-sh')).toBeNull();
  });
});

describe('computeTrackedChanges', () => {
  it('首次检查（空 cursor）只建基线，不通知已有 release', () => {
    expect(computeTrackedChanges({}, { repo: repo(), releases: [release()] }, NOW)).toEqual([]);
  });

  it('release tag 变化 → 通知，并带上距上个版本的天数', () => {
    const changes = computeTrackedChanges(
      { releaseTag: 'v1.1.0', releasePublishedAt: '2026-10-02T00:00:00Z', lastStars: 1000 },
      { repo: repo(), releases: [release()] },
      NOW,
    );
    const releaseChange = changes.find((change) => change.kind === 'release');
    expect(releaseChange?.facts).toContain('v1.2.0');
    expect(releaseChange?.facts).toContain('18 天');
  });

  it('同一个 tag 不重复通知；prerelease 不算', () => {
    expect(
      computeTrackedChanges(
        { releaseTag: 'v1.2.0', releasePublishedAt: '2026-10-20T00:00:00Z', lastStars: 1200 },
        { repo: repo(), releases: [release()] },
        NOW,
      ),
    ).toEqual([]);
    expect(
      computeTrackedChanges(
        { releaseTag: 'v1.1.0', lastStars: 1200 },
        { repo: repo(), releases: [release({ tag: 'v2.0.0-rc1', prerelease: true })] },
        NOW,
      ),
    ).toEqual([]);
  });

  it('star 增量达到 max(50, 当前 5%) → 通知', () => {
    const big = repo({ stars: 10000 });
    expect(
      computeTrackedChanges({ releaseTag: 'v1.2.0', lastStars: 9500 }, { repo: big, releases: [] }, NOW)
        .some((change) => change.kind === 'star-surge'),
    ).toBe(true);

    expect(
      computeTrackedChanges({ releaseTag: 'v1.2.0', lastStars: 9501 }, { repo: big, releases: [] }, NOW),
    ).toEqual([]);
  });

  it('小仓库用 50 的绝对下限，避免 3 个 star 也算暴涨', () => {
    const small = repo({ stars: 400 });
    expect(
      computeTrackedChanges({ releaseTag: 'v1.2.0', lastStars: 360 }, { repo: small, releases: [] }, NOW)
        .some((change) => change.kind === 'star-surge'),
    ).toBe(false);
  });

  it('仓库从未归档变为 archive → 通知一次，之后不再通知', () => {
    const archived = repo({ archived: true });
    expect(
      computeTrackedChanges({ releaseTag: 'v1.2.0', lastStars: 1200 }, { repo: archived, releases: [] }, NOW)
        .some((change) => change.kind === 'archived'),
    ).toBe(true);

    expect(
      computeTrackedChanges(
        { releaseTag: 'v1.2.0', lastStars: 1200, archived: true },
        { repo: archived, releases: [] },
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('formatTrackedSummary', () => {
  it('没有变化返回 null；有变化时按事实行输出，不超过 1900 字节', () => {
    const changes: TrackedChange[] = [
      { kind: 'release', facts: 'acme/rocket：v1.2.0 发布（距上个版本 18 天）' },
      { kind: 'star-surge', facts: 'acme/rocket：24 小时星标 +520（9500 → 10020）' },
    ];
    const text = formatTrackedSummary('2026-10-29', changes);
    expect(text).toContain('跟踪变化（10-29）');
    expect(text).toContain('v1.2.0');
    expect(Buffer.byteLength(text as string, 'utf8')).toBeLessThanOrEqual(1900);
    expect(formatTrackedSummary('2026-10-29', [])).toBeNull();
  });
});
