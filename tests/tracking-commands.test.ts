import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 跟踪命令：只管「解析 → 校验 → 落库 → 回执」。
 * db / GitHub 客户端 / 发消息全部打桩，不触网、不连库。
 */

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  insertCalls: [] as Record<string, unknown>[],
  updateCalls: [] as Record<string, unknown>[],
}));

const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
}));

const clientMock = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getReleases: vi.fn(),
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => dbMock.selectQueue.shift() ?? [],
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbMock.insertCalls.push(values);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbMock.updateCalls.push(values);
        },
      }),
    }),
  }),
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

vi.mock('../src/github/client', () => ({
  createGithubClient: () => clientMock,
}));

vi.mock('../src/config', () => ({
  env: { GITHUB_TOKEN: 'gh-token' },
}));

import {
  TRACK_LIMIT_REPLY,
  TRACK_USAGE_REPLY,
  handleMyTracking,
  handleTrack,
  handleUntrack,
} from '../src/wecom/tracking-commands';
import { decideTextRoute } from '../src/wecom/route-decision';
import type { InboundMessage } from '../src/wecom/router';

function msg(content: string): InboundMessage {
  return {
    toUserName: 'corp',
    fromUserName: 'alice',
    createTime: 0,
    msgType: 'text',
    content,
    msgId: 'm1',
  };
}

function repo() {
  return {
    fullName: 'acme/rocket',
    description: null,
    language: 'TypeScript',
    stars: 1200,
    forks: 10,
    openIssues: 1,
    pushedAt: null,
    createdAt: null,
    archived: false,
    license: null,
    topics: [],
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/acme/rocket',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectQueue.length = 0;
  dbMock.insertCalls.length = 0;
  dbMock.updateCalls.length = 0;
  clientMock.getRepo.mockResolvedValue({ ok: true, data: repo(), cached: false });
  clientMock.getReleases.mockResolvedValue({ ok: true, data: [], cached: false });
});

describe('handleTrack', () => {
  it('非法目标 → 用法提示，不请求 GitHub、不写库', async () => {
    await handleTrack(msg('追踪 随便一句话'));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', TRACK_USAGE_REPLY);
    expect(clientMock.getRepo).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
  });

  it('成功 → 用当前 star/release 建基线，写库并确认', async () => {
    dbMock.selectQueue.push([]); // 现有跟踪数为 0
    clientMock.getReleases.mockResolvedValue({
      ok: true,
      data: [{ tag: 'v1.2.0', name: null, publishedAt: '2026-10-20T00:00:00Z', prerelease: false }],
      cached: false,
    });

    await handleTrack(msg('追踪 astral-sh/ruff'));

    expect(clientMock.getRepo).toHaveBeenCalledTimes(1);
    const written = dbMock.insertCalls.find((call) => call.identifier !== undefined);
    expect(written).toMatchObject({
      wecomUserid: 'alice',
      kind: 'repo',
      identifier: 'astral-sh/ruff',
      displayName: 'astral-sh/ruff',
      cursor: expect.objectContaining({ releaseTag: 'v1.2.0', lastStars: 1200 }),
    });
    const reply = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(reply).toContain('已跟踪');
    expect(reply).toContain('astral-sh/ruff');
  });

  it('已满 10 个 → 拒绝，不请求 GitHub、不写库', async () => {
    dbMock.selectQueue.push(Array.from({ length: 10 }, () => ({ identifier: 'a/b' })));

    await handleTrack(msg('追踪 astral-sh/ruff'));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', TRACK_LIMIT_REPLY);
    expect(clientMock.getRepo).not.toHaveBeenCalled();
    expect(dbMock.insertCalls).toHaveLength(0);
  });
});

describe('handleMyTracking', () => {
  it('列出编号跟踪项，并把列表写入 kv 供「取消追踪 N」使用', async () => {
    dbMock.selectQueue.push([
      { identifier: 'acme/rocket', displayName: 'acme/rocket' },
      { identifier: 'astral-sh/ruff', displayName: 'astral-sh/ruff' },
    ]);

    await handleMyTracking(msg('我的追踪'));

    const reply = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(reply).toContain('1. acme/rocket');
    expect(reply).toContain('2. astral-sh/ruff');
    const cached = dbMock.insertCalls.find((call) => call.key !== undefined);
    expect(cached?.key).toBe('tracking-list:v1:alice');
  });

  it('没有跟踪项 → 给引导文案', async () => {
    dbMock.selectQueue.push([]);
    await handleMyTracking(msg('我的追踪'));
    const reply = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(reply).toContain('还没有');
  });
});

describe('handleUntrack', () => {
  it('按序号取消：直接查库取 identifier，置 active=false（不依赖先发「我的追踪」）', async () => {
    dbMock.selectQueue.push([
      { identifier: 'acme/rocket', displayName: 'acme/rocket' },
    ]);

    await handleUntrack(msg('取消追踪 1'));

    expect(dbMock.updateCalls[0]).toMatchObject({ active: false });
    const reply = apiMock.sendWeComText.mock.calls[0]?.[1] as string;
    expect(reply).toContain('已取消');
    expect(reply).toContain('acme/rocket');
  });

  it('「取消追踪1」（无空格）也走同一路径', async () => {
    expect(decideTextRoute('取消追踪1')).toEqual({ kind: 'handler', handler: 'untrack' });
  });

  it('无法解析的目标 → 用法提示，不写库', async () => {
    await handleUntrack(msg('取消追踪'));
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(dbMock.updateCalls).toHaveLength(0);
  });
});
