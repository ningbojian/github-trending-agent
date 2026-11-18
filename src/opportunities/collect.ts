import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { sourceItems, trendingEntries } from '../db/schema.js';
import {
  githubClient,
  parseRepoRef,
  type GithubClient,
  type IssueInfo,
  type RepoInfo,
} from '../github/client.js';
import { scoreOpportunity } from './score.js';
import type { OpportunityKind, RawOpportunityFact } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPOS = 60;
const MAX_BODY_CHARS = 2000;

export interface CollectResult {
  facts: RawOpportunityFact[];
  reposChecked: number;
  requests: number;
  errors: string[];
}

export interface CollectDeps {
  client?: GithubClient;
  listCandidateRepos?: (now: Date) => Promise<string[]>;
  token?: string | null;
  maxRepos?: number;
}

function dayString(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** 公开候选：当日热榜 + 近 7 天 GitHub Search 新仓库；不含任何用户数据。 */
async function defaultListCandidateRepos(now: Date): Promise<string[]> {
  const cutoff = dayString(now, 7);
  const [trending, search] = await Promise.all([
    db()
      .select({ fullName: trendingEntries.fullName })
      .from(trendingEntries)
      .where(gte(trendingEntries.date, cutoff))
      .orderBy(desc(trendingEntries.starsDelta))
      .limit(20),
    db()
      .select({ sourceId: sourceItems.sourceId })
      .from(sourceItems)
      .where(
        and(
          eq(sourceItems.source, 'github_search'),
          gte(sourceItems.capturedDate, cutoff),
        ),
      )
      .orderBy(desc(sourceItems.capturedAt))
      .limit(30),
  ]);
  return [...new Set([...trending.map((row) => row.fullName), ...search.map((row) => row.sourceId)])].slice(
    0,
    MAX_REPOS,
  );
}

function toFact(
  repo: RepoInfo,
  issue: IssueInfo,
  kind: OpportunityKind,
): RawOpportunityFact {
  return {
    id: `${kind}:${repo.fullName}#${issue.number}`,
    kind,
    repo: repo.fullName,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body.slice(0, MAX_BODY_CHARS),
    url: issue.htmlUrl,
    language: repo.language,
    topics: repo.topics,
    stars: repo.stars,
    license: repo.license,
    archived: repo.archived,
    pushedAt: repo.pushedAt,
    labels: issue.labels,
    comments: issue.comments,
    reactions: issue.reactions,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    maintainerEngaged: false,
    assigned: issue.assigned,
    // 仓库 issue 列表不提供 linked PR；全局 research 查询已用 -linked:pr 过滤。
    linkedPr: false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 采集公开机会事实。所有 GitHub 调用都在这里发生，结果写入 source_items；
 * 不做 LLM、不碰用户数据。单个仓库/查询失败只记录，不拖垮整批。
 */
export async function collectOpportunities(
  now: Date,
  deps: CollectDeps = {},
): Promise<CollectResult> {
  const client = deps.client ?? githubClient;
  const token =
    deps.token !== undefined ? deps.token : env.GITHUB_TOKEN ?? null;
  const maxRepos = deps.maxRepos ?? MAX_REPOS;
  const listCandidateRepos = deps.listCandidateRepos ?? defaultListCandidateRepos;
  const facts: RawOpportunityFact[] = [];
  const errors: string[] = [];
  const repoCache = new Map<string, RepoInfo | null>();
  let requests = 0;

  const loadRepo = async (repo: string): Promise<RepoInfo | null> => {
    if (repoCache.has(repo)) return repoCache.get(repo) ?? null;
    const ref = parseRepoRef(repo);
    if (!ref) {
      repoCache.set(repo, null);
      errors.push(`${repo}: invalid repo ref`);
      return null;
    }
    requests += 1;
    const result = await client.getRepo(ref, token);
    if (!result.ok) {
      errors.push(`${repo}: ${result.message}`);
      repoCache.set(repo, null);
      return null;
    }
    repoCache.set(repo, result.data);
    return result.data;
  };

  let candidates: string[] = [];
  try {
    candidates = [
      ...new Set(await listCandidateRepos(now)),
    ].slice(0, maxRepos);
  } catch (err) {
    errors.push(`candidates: ${errorMessage(err)}`);
  }

  for (const repo of candidates) {
    try {
      const info = await loadRepo(repo);
      if (!info) continue;
      const ref = parseRepoRef(repo);
      if (!ref) continue;
      for (const label of ['good first issue', 'help wanted']) {
        requests += 1;
        const result = await client.listIssues(ref, {
          labels: [label],
          perPage: 10,
          token,
        });
        if (!result.ok) {
          errors.push(`${repo} ${label}: ${result.message}`);
          continue;
        }
        for (const issue of result.data) {
          if (issue.pullRequest) continue;
          facts.push(toFact(info, issue, 'contribute'));
        }
      }
    } catch (err) {
      errors.push(`${repo}: ${errorMessage(err)}`);
    }
  }

  // 研究机会用全局搜索：标签是仓库自定义的，逐个仓库查会漏且浪费配额。
  const updatedSince = dayString(now, 30);
  const researchQueries = [
    `is:issue is:open label:RFC reactions:>=5 updated:>=${updatedSince} -linked:pr`,
    `is:issue is:open label:proposal reactions:>=5 updated:>=${updatedSince} -linked:pr`,
    `is:issue is:open label:"design proposal" reactions:>=5 updated:>=${updatedSince} -linked:pr`,
    `is:issue is:open label:research reactions:>=5 updated:>=${updatedSince} -linked:pr`,
  ];
  for (const query of researchQueries) {
    try {
      requests += 1;
      const result = await client.searchIssues(query, {
        perPage: 20,
        token,
      });
      if (!result.ok) {
        errors.push(`research search: ${result.message}`);
        continue;
      }
      for (const issue of result.data) {
        if (issue.pullRequest) continue;
        const repo = issue.repository;
        if (!repo) continue;
        const info = await loadRepo(repo);
        if (!info) continue;
        facts.push(toFact(info, issue, 'research'));
      }
    } catch (err) {
      errors.push(`research search: ${errorMessage(err)}`);
    }
  }

  const uniqueFacts = [...new Map(facts.map((fact) => [fact.id, fact])).values()];

  // 维护者互动 + linked PR 是最强的质量信号；只对首轮分数最高的一小批
  // 多打 comments / timeline 两次请求。其余条目的 linkedPr 保持 false（未知），
  // 由质量门槛按「未确认」处理。
  const top = [...uniqueFacts]
    .sort(
      (a, b) =>
        scoreOpportunity(b, now.getTime()) -
        scoreOpportunity(a, now.getTime()),
    )
    .slice(0, 30);
  for (const fact of top) {
    const ref = parseRepoRef(fact.repo);
    if (!ref) continue;
    try {
      requests += 2;
      const [comments, timeline] = await Promise.all([
        client.getIssueComments(ref, fact.issueNumber, token),
        client.getIssueTimeline(ref, fact.issueNumber, token),
      ]);
      if (comments.ok) {
        fact.maintainerEngaged = comments.data.some((comment) =>
          ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(
            (comment.authorAssociation ?? '').toUpperCase(),
          ),
        );
      } else {
        errors.push(`${fact.id}: ${comments.message}`);
      }
      if (timeline.ok) {
        fact.linkedPr = timeline.data.linkedPr;
      } else {
        errors.push(`${fact.id}: ${timeline.message}`);
      }
    } catch (err) {
      errors.push(`${fact.id}: ${errorMessage(err)}`);
    }
  }

  return {
    facts: uniqueFacts,
    reposChecked: candidates.length,
    requests,
    errors,
  };
}

/** 把公开事实 upsert 到 source_items；一天一行/issue，不存用户信息。 */
export async function upsertOpportunityFacts(
  facts: RawOpportunityFact[],
  date: string,
): Promise<number> {
  if (facts.length === 0) return 0;
  const now = new Date();
  const rows = facts.map((fact) => ({
    source: 'opportunity',
    sourceId: fact.id,
    itemType: 'issue',
    title: fact.title,
    url: fact.url,
    author: null,
    description: fact.body.slice(0, MAX_BODY_CHARS),
    topics: fact.topics,
    metrics: {
      stars: fact.stars,
      comments: fact.comments,
      reactions: fact.reactions,
    },
    raw: {
      kind: fact.kind,
      repo: fact.repo,
      issueNumber: fact.issueNumber,
      labels: fact.labels,
      language: fact.language,
      license: fact.license,
      archived: fact.archived,
      pushedAt: fact.pushedAt,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
      maintainerEngaged: fact.maintainerEngaged,
      assigned: fact.assigned,
      linkedPr: fact.linkedPr,
    },
    capturedDate: date,
    capturedAt: now,
  }));
  await db()
    .insert(sourceItems)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        sourceItems.source,
        sourceItems.sourceId,
        sourceItems.capturedDate,
      ],
      set: {
        itemType: sql`excluded.item_type`,
        title: sql`excluded.title`,
        url: sql`excluded.url`,
        author: sql`excluded.author`,
        description: sql`excluded.description`,
        topics: sql`excluded.topics`,
        metrics: sql`excluded.metrics`,
        raw: sql`excluded.raw`,
        capturedAt: sql`excluded.captured_at`,
      },
    });
  return rows.length;
}
