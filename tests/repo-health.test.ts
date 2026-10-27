import { describe, expect, it } from 'vitest';
import type { CommitInfo, ReleaseInfo, RepoInfo } from '../src/github/client';
import { computeRepoHealth } from '../src/agent/repo-health';

/**
 * 仓库健康度：所有指标由代码计算，模型只负责解释。
 * 纯函数，时间注入，不碰网络/DB。
 */

const NOW = Date.parse('2026-10-27T00:00:00Z');

function repo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    fullName: 'astral-sh/ruff',
    description: 'An extremely fast Python linter.',
    language: 'Rust',
    stars: 40_000,
    forks: 1_400,
    openIssues: 1_200,
    pushedAt: '2026-10-25T00:00:00Z',
    createdAt: '2022-08-09T00:00:00Z',
    archived: false,
    license: 'MIT',
    topics: ['python', 'linter'],
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/astral-sh/ruff',
    ...overrides,
  };
}

function release(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag: 'v0.14.0',
    name: 'v0.14.0',
    publishedAt: '2026-10-01T00:00:00Z',
    prerelease: false,
    ...overrides,
  };
}

function commit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: 'abc123',
    message: 'Fix something',
    author: 'charliermarsh',
    date: '2026-10-26T00:00:00Z',
    ...overrides,
  };
}

/** 按 kind 找信号，找不到直接失败（测试里拼错标签要立刻暴露）。 */
function signal(health: ReturnType<typeof computeRepoHealth>, kind: string) {
  const found = health.signals.find((item) => item.kind === kind);
  if (found === undefined) throw new Error(`missing signal: ${kind}`);
  return found;
}

describe('computeRepoHealth — 判定', () => {
  it('活跃项目 → healthy，并给出可引用的事实', () => {
    const health = computeRepoHealth(repo(), [release()], [commit()], NOW);
    expect(health.verdict).toBe('healthy');
    expect(health.score).toBe(100);
    expect(health.facts.daysSincePush).toBe(2);
    expect(health.facts.daysSinceCommit).toBe(1);
    expect(health.facts.daysSinceRelease).toBe(26);
    expect(health.facts.latestRelease).toBe('v0.14.0');
    expect(health.signals.every((item) => item.ok)).toBe(true);
  });

  it('已归档 → risky（归档就是「别用」的最强信号）', () => {
    const health = computeRepoHealth(repo({ archived: true }), [release()], [commit()], NOW);
    expect(health.verdict).toBe('risky');
    expect(signal(health, 'archived').ok).toBe(false);
    expect(signal(health, 'archived').detail).toContain('归档');
    expect(health.score).toBeLessThan(50);
  });

  it('一年没推送 → risky', () => {
    const health = computeRepoHealth(
      repo({ pushedAt: '2025-01-01T00:00:00Z' }),
      [release()],
      [commit({ date: '2026-10-20T00:00:00Z' })],
      NOW,
    );
    expect(health.verdict).toBe('risky');
    expect(signal(health, 'stale-push').ok).toBe(false);
    expect(signal(health, 'stale-push').detail).toContain('天');
  });

  it('半年没推送 → watch（不是不能用，但要提醒）', () => {
    const health = computeRepoHealth(
      repo({ pushedAt: '2026-04-01T00:00:00Z' }),
      [release()],
      [commit({ date: '2026-04-01T00:00:00Z' })],
      NOW,
    );
    expect(health.verdict).toBe('watch');
    expect(signal(health, 'stale-push').ok).toBe(false);
  });

  it('最近一次提交超过 90 天 → watch，即使 pushedAt 很新', () => {
    const health = computeRepoHealth(
      repo(),
      [release()],
      [commit({ date: '2026-05-01T00:00:00Z' })],
      NOW,
    );
    expect(signal(health, 'stale-commit').ok).toBe(false);
    expect(health.verdict).toBe('watch');
  });

  it('没有许可证 → watch（采用风险，不是质量风险）', () => {
    const health = computeRepoHealth(repo({ license: null }), [release()], [commit()], NOW);
    expect(health.verdict).toBe('watch');
    expect(signal(health, 'license').ok).toBe(false);
    expect(signal(health, 'license').detail).toContain('许可证');
  });

  it('每千星未关闭 issue 超过 30 → watch', () => {
    // 40k 星、3000 个未关闭 issue = 75/千星
    const health = computeRepoHealth(
      repo({ openIssues: 3_000 }),
      [release()],
      [commit()],
      NOW,
    );
    expect(health.facts.issuesPerKStar).toBe(75);
    expect(signal(health, 'issues').ok).toBe(false);
    expect(health.verdict).toBe('watch');
  });

  it('没有 release → watch，但不算 risky', () => {
    const health = computeRepoHealth(repo(), [], [commit()], NOW);
    expect(health.verdict).toBe('watch');
    expect(signal(health, 'releases').ok).toBe(false);
    expect(health.facts.latestRelease).toBeNull();
    expect(health.facts.daysSinceRelease).toBeNull();
  });

  it('只有预发布 → watch 并标注预发布', () => {
    const health = computeRepoHealth(
      repo(),
      [release({ prerelease: true, tag: 'v0.15.0-rc1' })],
      [commit()],
      NOW,
    );
    expect(signal(health, 'prerelease').ok).toBe(false);
    expect(health.verdict).toBe('watch');
  });

  it('score 永不为负，且与 verdict 单调一致', () => {
    const health = computeRepoHealth(
      repo({ archived: true, license: null, pushedAt: '2019-01-01T00:00:00Z', openIssues: 9_999 }),
      [],
      [commit({ date: '2019-01-01T00:00:00Z' })],
      NOW,
    );
    expect(health.score).toBe(0);
    expect(health.verdict).toBe('risky');
  });

  it('缺失时间字段不崩，按未知处理并给出信号', () => {
    const health = computeRepoHealth(
      repo({ pushedAt: null }),
      [release({ publishedAt: null })],
      [commit({ date: null })],
      NOW,
    );
    expect(signal(health, 'stale-push').ok).toBe(false);
    expect(health.facts.daysSincePush).toBeNull();
    expect(health.facts.daysSinceCommit).toBeNull();
    expect(health.facts.daysSinceRelease).toBeNull();
  });
});
