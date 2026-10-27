import type { CommitInfo, ReleaseInfo, RepoInfo } from '../github/client.js';

/**
 * 仓库健康度：**指标由代码算，模型只负责解释。**
 *
 * 为什么不让模型自己算：模型数不清日历、也守不住阈值，同样的输入两次能给两个
 * 结论。这里输出确定性的 score / verdict / signals，模型只能引用——用户追问
 * 「为什么说它不活跃」时，答案必须是「最近一次提交 209 天前」这种事实。
 *
 * 阈值是产品判断，不是行业标准，集中放在下面几个常量里，方便有据可查地调整。
 */

/** 超过这个天数没推送 → 至少 watch。 */
const PUSH_WATCH_DAYS = 180;
/** 超过这个天数没推送 → risky。 */
const PUSH_RISKY_DAYS = 365;
/** 最近一次提交超过这个天数 → watch。 */
const COMMIT_STALE_DAYS = 90;
/** 每千星未关闭 issue 上限；超过说明维护者消化不过来。 */
const ISSUES_PER_KSTAR_LIMIT = 30;

export type HealthVerdict = 'healthy' | 'watch' | 'risky';

export type HealthSignalKind =
  | 'archived'
  | 'stale-push'
  | 'stale-commit'
  | 'issues'
  | 'license'
  | 'releases'
  | 'prerelease';

export interface HealthSignal {
  kind: HealthSignalKind;
  /** 这一项是否让人放心；false 的项就是「需要注意的点」。 */
  ok: boolean;
  /** 中文一句话，可直接进回复。 */
  detail: string;
}

export interface RepoHealthFacts {
  daysSincePush: number | null;
  daysSinceCommit: number | null;
  daysSinceRelease: number | null;
  issuesPerKStar: number;
  latestRelease: string | null;
}

export interface RepoHealth {
  verdict: HealthVerdict;
  /** 0–100，扣分制；只用于排序和「有多严重」的直观表达。 */
  score: number;
  signals: HealthSignal[];
  facts: RepoHealthFacts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 时间 → 距 now 的天数；缺失/非法一律 null（未知，不等于「很久」）。 */
export function daysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / DAY_MS));
}

function byOk(ok: boolean, kind: HealthSignalKind, detail: string): HealthSignal {
  return { kind, ok, detail };
}

/**
 * 计算健康度。`now` 显式传入，测试与线上用的是同一套逻辑，不依赖机器时钟的
 * 时区/漂移；commits 只需最近的一条到最新（调用方传 GitHub 的最近 5 条）。
 */
export function computeRepoHealth(
  repo: RepoInfo,
  releases: ReleaseInfo[],
  commits: CommitInfo[],
  now: number,
): RepoHealth {
  const daysSincePush = daysSince(repo.pushedAt, now);
  const daysSinceCommit = daysSince(commits[0]?.date ?? null, now);
  const latest = releases[0] ?? null;
  const daysSinceRelease = daysSince(latest?.publishedAt ?? null, now);
  const issuesPerKStar = Math.round((repo.openIssues / Math.max(repo.stars, 1)) * 1000 * 10) / 10;
  const prereleaseOnly = releases.length > 0 && releases.every((item) => item.prerelease);

  let score = 100;
  const signals: HealthSignal[] = [];

  signals.push(
    repo.archived
      ? byOk(false, 'archived', '仓库已归档（不再维护）')
      : byOk(true, 'archived', '未归档'),
  );
  if (repo.archived) score -= 60;

  if (daysSincePush === null) {
    signals.push(byOk(false, 'stale-push', '没有推送时间（按未知处理）'));
    score -= 10;
  } else if (daysSincePush > PUSH_RISKY_DAYS) {
    signals.push(byOk(false, 'stale-push', `${daysSincePush} 天没推送（超过一年）`));
    score -= 40;
  } else if (daysSincePush > PUSH_WATCH_DAYS) {
    signals.push(byOk(false, 'stale-push', `${daysSincePush} 天没推送`));
    score -= 20;
  } else {
    signals.push(byOk(true, 'stale-push', `${daysSincePush} 天前推送过`));
  }

  if (daysSinceCommit === null) {
    signals.push(byOk(false, 'stale-commit', '拿不到最近提交时间'));
    score -= 5;
  } else if (daysSinceCommit > COMMIT_STALE_DAYS) {
    signals.push(byOk(false, 'stale-commit', `最近一次提交在 ${daysSinceCommit} 天前`));
    score -= daysSinceCommit > PUSH_WATCH_DAYS ? 20 : 10;
  } else {
    signals.push(byOk(true, 'stale-commit', `最近一次提交在 ${daysSinceCommit} 天前`));
  }

  signals.push(
    issuesPerKStar > ISSUES_PER_KSTAR_LIMIT
      ? byOk(false, 'issues', `每千星有 ${issuesPerKStar} 个未关闭 issue（维护压力大）`)
      : byOk(true, 'issues', `每千星 ${issuesPerKStar} 个未关闭 issue`),
  );
  if (issuesPerKStar > ISSUES_PER_KSTAR_LIMIT) score -= 10;

  signals.push(
    repo.license === null
      ? byOk(false, 'license', '没有声明许可证（公司使用前需确认）')
      : byOk(true, 'license', `许可证：${repo.license}`),
  );
  if (repo.license === null) score -= 10;

  if (latest === null) {
    signals.push(byOk(false, 'releases', '没有发布记录'));
    score -= 5;
  } else {
    signals.push(
      byOk(
        true,
        'releases',
        daysSinceRelease === null ? `最近发布：${latest.tag}` : `最近发布：${latest.tag}（${daysSinceRelease} 天前）`,
      ),
    );
    signals.push(
      prereleaseOnly
        ? byOk(false, 'prerelease', '最近只有预发布版本')
        : byOk(true, 'prerelease', '有正式版本'),
    );
    if (prereleaseOnly) score -= 5;
  }

  score = Math.max(0, score);

  const risky =
    repo.archived ||
    score < 55 ||
    (daysSincePush !== null && daysSincePush > PUSH_RISKY_DAYS);
  const watch = !risky && (score < 90 || signals.some((item) => !item.ok));
  const verdict: HealthVerdict = risky ? 'risky' : watch ? 'watch' : 'healthy';

  return {
    verdict,
    score,
    signals,
    facts: { daysSincePush, daysSinceCommit, daysSinceRelease, issuesPerKStar, latestRelease: latest?.tag ?? null },
  };
}
