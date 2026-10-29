import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 每日跟踪检查：到期筛选、按用户原子处理、每天一条、发送成功才推进 cursor。
 * db / GitHub / 发消息全部打桩。
 */

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  insertCalls: [] as Record<string, unknown>[],
  updateCalls: [] as Record<string, unknown>[],
}));

const apiMock = vi.hoisted(() => ({ sendWeComText: vi.fn() }));
const clientMock = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getReleases: vi.fn(),
}));
const configMock = vi.hoisted(() => ({ env: { GITHUB_TOKEN: 'gh-token' as string | undefined } }));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => dbMock.selectQueue.shift() ?? [],
        innerJoin: () => ({ where: async () => dbMock.selectQueue.shift() ?? [] }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbMock.updateCalls.push(values);
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbMock.insertCalls.push(values);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

vi.mock('../src/wecom/api', () => ({ sendWeComText: apiMock.sendWeComText }));
vi.mock('../src/github/client', () => ({ createGithubClient: () => clientMock }));
vi.mock('../src/config', () => ({ env: configMock.env }));

import { pushTrackedChanges } from '../src/agent/tracking-check';

const NOW = new Date('2026-10-29T01:00:00Z');

function dueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    wecomUserid: 'alice',
    identifier: 'acme/rocket',
    displayName: 'acme/rocket',
    cursor: { releaseTag: 'v1.1.0', releasePublishedAt: '2026-10-02T00:00:00Z', lastStars: 1200 },
    ...overrides,
  };
}

function repo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fullName: 'acme/rocket',
    description: null,
    language: 'TypeScript',
    stars: 1200,
    forks: 1,
    openIssues: 0,
    pushedAt: null,
    createdAt: null,
    archived: false,
    license: null,
    topics: [],
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/acme/rocket',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectQueue.length = 0;
  dbMock.insertCalls.length = 0;
  dbMock.updateCalls.length = 0;
  configMock.env.GITHUB_TOKEN = 'gh-token';
  clientMock.getRepo.mockResolvedValue({ ok: true, data: repo(), cached: false });
  clientMock.getReleases.mockResolvedValue({
    ok: true,
    data: [{ tag: 'v1.2.0', name: null, publishedAt: '2026-10-20T00:00:00Z', prerelease: false }],
    cached: false,
  });
});

describe('pushTrackedChanges', () => {
  it('没有 GITHUB_TOKEN → 不查库、不请求 GitHub', async () => {
    configMock.env.GITHUB_TOKEN = undefined;
    const result = await pushTrackedChanges({ now: NOW });
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0, checked: 0 });
    expect(dbMock.selectQueue).toHaveLength(0);
    expect(clientMock.getRepo).not.toHaveBeenCalled();
  });

  it('首次检查（空 cursor）→ 不通知，只推进 last_checked_at', async () => {
    dbMock.selectQueue.push([dueRow({ cursor: {} })]);
    dbMock.selectQueue.push([]); // marker 不存在

    const result = await pushTrackedChanges({ now: NOW });

    expect(result.skipped).toBe(1);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(dbMock.updateCalls[0]).toMatchObject({ lastCheckedAt: NOW });
    expect(dbMock.updateCalls[0]).not.toHaveProperty('cursor');
  });

  it('release 变化 → 发一条摘要，成功后推进 cursor', async () => {
    dbMock.selectQueue.push([dueRow()]);
    dbMock.selectQueue.push([]);

    const result = await pushTrackedChanges({ now: NOW });

    expect(result.sent).toBe(1);
    const text = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(text).toContain('跟踪变化（10-29）');
    expect(text).toContain('v1.2.0');
    const marker = dbMock.insertCalls.find((call) => String(call.key).includes('tracked-notice'));
    expect(marker).toBeDefined();
    const cursorUpdate = dbMock.updateCalls.find((call) => call.cursor !== undefined);
    expect(cursorUpdate).toMatchObject({
      cursor: expect.objectContaining({ releaseTag: 'v1.2.0', lastStars: 1200 }),
      lastCheckedAt: NOW,
    });
  });

  it('今天已经发过变化摘要（marker 命中）→ 跳过，不再请求 GitHub', async () => {
    dbMock.selectQueue.push([dueRow()]);
    dbMock.selectQueue.push([{ expiresAt: new Date(NOW.getTime() + 1000) }]);

    const result = await pushTrackedChanges({ now: NOW });

    expect(result.skipped).toBe(1);
    expect(clientMock.getRepo).not.toHaveBeenCalled();
  });

  it('发送失败 → marker 已写但 cursor 不推进（下个 tick 重试）', async () => {
    dbMock.selectQueue.push([dueRow()]);
    dbMock.selectQueue.push([]);
    apiMock.sendWeComText.mockRejectedValueOnce(new Error('send failed'));

    const result = await pushTrackedChanges({ now: NOW });

    expect(result.failed).toBe(1);
    expect(dbMock.updateCalls.some((call) => call.cursor !== undefined)).toBe(false);
  });
});

describe('预算', () => {
  it('同一用户 10 个条目并行检查，不会被“每条 6 秒”误杀', async () => {
    dbMock.selectQueue.push(
      Array.from({ length: 10 }, (_, i) =>
        dueRow({ id: i + 1, identifier: `a/r${i}`, cursor: {} }),
      ),
    );
    dbMock.selectQueue.push([]); // marker

    const result = await pushTrackedChanges({ now: NOW, budgetMs: 45_000 });

    expect(result.checked).toBe(10);
    expect(clientMock.getRepo).toHaveBeenCalledTimes(10);
  });
});
