import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import type { GithubClient } from '../src/github/client';
import type { SearchResultItem } from '../src/agent/search';
import type { InboundMessage } from '../src/wecom/router';
import { tryAgentReply, type AgentRouteOptions } from '../src/wecom/agent-route';

/**
 * 工具链路的执行外壳：谁付钱、成功发什么、失败怎么退回原路。
 * 模型、GitHub、DB、发送全部注入——测试里没有网络、没有 env、没有 Key。
 */

const NOW = Date.parse('2026-10-27T00:00:00Z');

const MSG: InboundMessage = {
  toUserName: 'corp',
  fromUserName: 'zhangsan',
  createTime: 0,
  msgType: 'text',
  content: '深挖 astral-sh/ruff',
  msgId: 'm1',
};

function item(fullName: string): SearchResultItem {
  return {
    fullName,
    description: null,
    language: 'Python',
    stars: 1000,
    starsDelta: 100,
    isNew: false,
    date: '2026-10-27',
    htmlUrl: `https://github.com/${fullName}`,
    rank: 1,
  };
}

function fakeGithub(): GithubClient {
  return {
    async getRepo() {
      return {
        ok: true,
        cached: false,
        data: {
          fullName: 'astral-sh/ruff',
          description: 'linter',
          language: 'Rust',
          stars: 40_000,
          forks: 1_400,
          openIssues: 1_200,
          pushedAt: '2026-10-25T00:00:00Z',
          createdAt: '2022-08-09T00:00:00Z',
          archived: false,
          license: 'MIT',
          topics: [],
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/astral-sh/ruff',
        },
      };
    },
    async getReadme() {
      return { ok: true, data: '# Ruff', cached: false };
    },
    async getReleases() {
      return { ok: true, data: [], cached: false };
    },
    async getCommits() {
      return { ok: true, data: [], cached: false };
    },
  };
}

interface Harness {
  sent: string[];
  generateCalls: number;
  options: AgentRouteOptions;
}

/**
 * 假模型要「真」调一次工具：AI SDK 在真实循环里会执行 tool.execute，
 * 只回一个声称调用过的 steps 不会有任何数据落地。
 */
async function runSearchTool(args: {
  tools: Record<string, unknown>;
}): Promise<void> {
  const tools = args.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  await tools.search_trending?.execute({});
}

function harness(overrides: Partial<AgentRouteOptions> = {}): Harness {
  const state = { generateCalls: 0 };
  const sent: string[] = [];
  const options: AgentRouteOptions = {
    choice: { kind: 'user', config: { baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'k' } },
    model: { modelId: 'fake' } as unknown as LanguageModel,
    formatItems: (items) => items.map((entry, i) => `${i + 1}. ${entry.fullName}`).join('\n') + '\nFOOTER',
    generate: async () => {
      state.generateCalls += 1;
      return { text: '这个仓库很活跃。', steps: [] };
    },
    send: async (_userid, text) => {
      sent.push(text);
    },
    search: async () => [item('a/b'), item('c/d')],
    github: fakeGithub(),
    readSubscription: async () => null,
    removeTerm: async () => ({ removed: true, keywords: [] }),
    getToken: async () => ({ token: null, source: 'anonymous' }),
    loadSummaries: async () => new Map(),
    now: () => NOW,
    ...overrides,
  };
  return {
    sent,
    get generateCalls() {
      return state.generateCalls;
    },
    options,
  };
}

describe('tryAgentReply — 谁付钱', () => {
  it('用户没配 Key → 直接放弃，零模型调用、不发消息', async () => {
    const h = harness({ choice: { kind: 'none' } });
    const handled = await tryAgentReply(MSG, h.options);
    expect(handled).toBe(false);
    expect(h.generateCalls).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it('模型没给出可用文本 → 放弃，交给原检索链路', async () => {
    const h = harness({ generate: async () => ({ text: '   ', steps: [] }) });
    expect(await tryAgentReply(MSG, h.options)).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('模型超时/抛错 → 放弃，不把异常抛给 router', async () => {
    const h = harness({
      generate: async () => {
        throw new Error('boom');
      },
    });
    expect(await tryAgentReply(MSG, h.options)).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe('tryAgentReply — 正常回复', () => {
  it('发送模型文本并返回 true', async () => {
    const h = harness();
    expect(await tryAgentReply(MSG, h.options)).toBe(true);
    expect(h.sent).toEqual(['这个仓库很活跃。']);
  });

  it('调用过 search_trending → 用同一份结果排版，编号与检索一致', async () => {
    const h = harness({
      generate: async (args) => {
        await runSearchTool(args);
        return {
          text: '找到两个相关项目。',
          steps: [{ toolCalls: [{ toolName: 'search_trending' }] }, { toolCalls: [] }],
        };
      },
    });
    expect(await tryAgentReply(MSG, h.options)).toBe(true);
    const reply = h.sent[0] ?? '';
    expect(reply).toContain('找到两个相关项目。');
    expect(reply).toContain('1. a/b');
    expect(reply).toContain('2. c/d');
    expect(reply).toContain('FOOTER');
  });

  it('模型文本 + 列表超过 1900 字节时，优先保住列表', async () => {
    const h = harness({
      generate: async (args) => {
        await runSearchTool(args);
        return {
          text: '长'.repeat(700), // 2100 字节
          steps: [{ toolCalls: [{ toolName: 'search_trending' }] }],
        };
      },
    });
    await tryAgentReply(MSG, h.options);
    const reply = h.sent[0] ?? '';
    expect(Buffer.byteLength(reply, 'utf8')).toBeLessThanOrEqual(1900);
    expect(reply).toContain('1. a/b');
    expect(reply.startsWith('长')).toBe(false);
  });

  it('检索结果为空时只发模型文本（不硬塞一个空列表）', async () => {
    const h = harness({
      search: async () => [],
      generate: async () => ({
        text: '榜单里暂时没有相关项目。',
        steps: [{ toolCalls: [{ toolName: 'search_trending' }] }],
      }),
    });
    await tryAgentReply(MSG, h.options);
    expect(h.sent).toEqual(['榜单里暂时没有相关项目。']);
  });
});

describe('tryAgentReply — 工具上下文', () => {
  it('repo_health 用代码算出的指标，模型拿到的不是「自己算」', async () => {
    let seen = '';
    const h = harness({
      generate: async (args) => {
        seen = args.system;
        return { text: '结论', steps: [] };
      },
    });
    await tryAgentReply(MSG, h.options);
    expect(seen).toContain('工具');
    expect(seen).toContain('不要编造');
  });

  it('deep_dive_repo 真被调用时走 GitHub 客户端（而不是检索）', async () => {
    let searchCalls = 0;
    const h = harness({
      search: async () => {
        searchCalls += 1;
        return [];
      },
      github: {
        ...fakeGithub(),
        async getRepo() {
          return { ok: false, failure: 'not-found', message: 'HTTP 404' };
        },
      },
      generate: async () => ({
        text: '没找到 astral-sh/ruff。',
        steps: [{ toolCalls: [{ toolName: 'deep_dive_repo' }] }],
      }),
    });
    await tryAgentReply(MSG, h.options);
    expect(searchCalls).toBe(0);
    expect(h.sent[0]).toContain('没找到');
  });
});
