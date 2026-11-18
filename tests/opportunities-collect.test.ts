import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubClient,
  IssueInfo,
  RepoInfo,
} from '../src/github/client';

const dbMock = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: unknown; values: unknown[] }>,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    insert: (table: unknown) => ({
      values: (values: unknown[]) => ({
        onConflictDoUpdate: async () => {
          dbMock.insertCalls.push({ table, values });
        },
      }),
    }),
  }),
}));

import {
  collectOpportunities,
  upsertOpportunityFacts,
} from '../src/opportunities/collect';

const NOW = new Date('2026-11-18T02:00:00.000Z');

const REPO: RepoInfo = {
  fullName: 'acme/agent',
  description: 'agent toolkit',
  language: 'TypeScript',
  stars: 500,
  forks: 10,
  openIssues: 20,
  pushedAt: '2026-11-10T00:00:00Z',
  createdAt: '2025-01-01T00:00:00Z',
  archived: false,
  license: 'MIT',
  topics: ['agent'],
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/acme/agent',
};

function issue(overrides: Partial<IssueInfo> = {}): IssueInfo {
  return {
    number: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤：...',
    htmlUrl: 'https://github.com/acme/agent/issues/12',
    repository: 'acme/agent',
    labels: ['good first issue'],
    comments: 3,
    reactions: 2,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    authorAssociation: 'CONTRIBUTOR',
    pullRequest: false,
    assigned: false,
    ...overrides,
  };
}

const GFI = issue();
const PR = issue({ number: 7, pullRequest: true, labels: [] });
const RFC = issue({
  number: 9,
  title: 'RFC: async drop 的语义边界',
  htmlUrl: 'https://github.com/acme/agent/issues/9',
  labels: ['RFC'],
  comments: 6,
  reactions: 10,
});

function fakeClient(overrides: Partial<GithubClient> = {}): GithubClient {
  const base: GithubClient = {
    async getRepo() {
      return { ok: true, data: REPO, cached: false };
    },
    async getReadme() {
      return { ok: true, data: null, cached: false };
    },
    async getReleases() {
      return { ok: true, data: [], cached: false };
    },
    async getCommits() {
      return { ok: true, data: [], cached: false };
    },
    async listIssues(_ref, options) {
      const label = options.labels?.[0];
      return {
        ok: true,
        data: label === 'good first issue' ? [GFI, PR] : [],
        cached: false,
      };
    },
    async getIssueComments() {
      return {
        ok: true,
        data: [{ authorAssociation: 'MEMBER', userLogin: 'maintainer' }],
        cached: false,
      };
    },
    async searchIssues(query) {
      return {
        ok: true,
        data: query.includes('label:RFC') ? [RFC] : [],
        cached: false,
      };
    },
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  dbMock.insertCalls.length = 0;
});

describe('collectOpportunities', () => {
  it('采集填坑和研究，过滤 PR，并标记维护者互动', async () => {
    const result = await collectOpportunities(NOW, {
      client: fakeClient(),
      listCandidateRepos: async () => ['acme/agent'],
      token: null,
    });

    expect(result.reposChecked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.facts.map((fact) => fact.id).sort()).toEqual([
      'contribute:acme/agent#12',
      'research:acme/agent#9',
    ]);
    expect(result.facts.every((fact) => fact.maintainerEngaged)).toBe(true);
    const contribute = result.facts.find((fact) => fact.kind === 'contribute')!;
    expect(contribute).toMatchObject({
      repo: 'acme/agent',
      issueNumber: 12,
      assigned: false,
      labels: ['good first issue'],
      stars: 500,
      license: 'MIT',
    });
    expect(result.requests).toBeGreaterThan(0);
  });

  it('单个仓库失败被记录，研究搜索仍然继续', async () => {
    const result = await collectOpportunities(NOW, {
      client: fakeClient({
        async listIssues() {
          throw new Error('boom');
        },
      }),
      listCandidateRepos: async () => ['acme/agent'],
      token: null,
    });

    expect(result.facts.map((fact) => fact.id)).toEqual([
      'research:acme/agent#9',
    ]);
    expect(result.errors.join('\n')).toContain('boom');
  });

  it('upsertOpportunityFacts 写入 source_items 形状', async () => {
    const result = await collectOpportunities(NOW, {
      client: fakeClient(),
      listCandidateRepos: async () => ['acme/agent'],
      token: null,
    });

    const count = await upsertOpportunityFacts(result.facts, '2026-11-18');
    expect(count).toBe(2);
    const rows = dbMock.insertCalls[0]!.values as Array<Record<string, unknown>>;
    const contribute = rows.find(
      (row) => row.sourceId === 'contribute:acme/agent#12',
    )!;
    expect(contribute).toMatchObject({
      source: 'opportunity',
      itemType: 'issue',
      capturedDate: '2026-11-18',
      title: 'Windows 下 CUDA 检测失败',
      url: 'https://github.com/acme/agent/issues/12',
    });
    expect(contribute.metrics).toMatchObject({
      stars: 500,
      comments: 3,
      reactions: 2,
    });
    expect(contribute.raw).toMatchObject({
      labels: ['good first issue'],
      maintainerEngaged: true,
      assigned: false,
    });
  });
});
