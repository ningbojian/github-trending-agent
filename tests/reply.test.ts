import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/wecom/router';

// ---------------------------------------------------------------------------
// Mocks：api（text+markdown）/ LLM / searchTrending / loadRepoSummaries / db —— 绝不触网、不连库。
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
  sendWeComMarkdown: vi.fn(),
}));

const llmMock = vi.hoisted(() => ({
  generateObjectSafe: vi.fn(),
}));

const searchMock = vi.hoisted(() => ({
  searchTrending: vi.fn(),
}));

const summaryMock = vi.hoisted(() => ({
  loadRepoSummaries: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  failExecute: false,
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
  sendWeComMarkdown: apiMock.sendWeComMarkdown,
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: llmMock.generateObjectSafe,
}));

vi.mock('../src/agent/search', () => ({
  searchTrending: searchMock.searchTrending,
}));

vi.mock('../src/agent/repo-summary', () => ({
  loadRepoSummaries: summaryMock.loadRepoSummaries,
}));

// db 兜底 mock：router 的 stars/onboarding 模块图需要 db 导出存在（本文件不经其路径）。
vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async () => {
      if (dbMock.failExecute) {
        throw new Error('db down');
      }
      return { rows: [] };
    },
  }),
}));

import type { SearchResultItem } from '../src/agent/search';
import {
  EMPTY_RESULT_REPLY,
  ERROR_REPLY,
  GUIDANCE_FOOTER,
  MAX_MARKDOWN_BYTES,
  formatSearchReply,
  handleSearch,
} from '../src/wecom/reply';
import { routeMessage } from '../src/wecom/router';

function makeItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    fullName: 'vercel/next.js',
    description: 'The React Framework',
    language: 'TypeScript',
    stars: 128000,
    starsDelta: 321,
    isNew: false,
    date: '2026-10-22',
    htmlUrl: 'https://github.com/vercel/next.js',
    rank: 1,
    ...overrides,
  };
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    toUserName: 'gh_agent',
    fromUserName: 'alice',
    createTime: 1409659813,
    msgType: 'text',
    content: 'python 热榜',
    msgId: '1001',
    ...overrides,
  };
}

/** 结构化解析产物：绕开 fallback 的不确定性，直接钉 query 形状。 */
function makeQuery(overrides: Partial<{
  languages: string[];
  keywords: string[];
  period: 'today' | 'week' | 'month' | 'all';
  minStars: number | null;
  sortBy: 'stars_delta' | 'stars' | 'new';
  topN: number;
}> = {}) {
  return {
    languages: [],
    keywords: [],
    period: 'week',
    minStars: null,
    sortBy: 'stars_delta',
    topN: 10,
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  apiMock.sendWeComMarkdown.mockReset();
  apiMock.sendWeComMarkdown.mockResolvedValue(undefined);
  llmMock.generateObjectSafe.mockReset();
  llmMock.generateObjectSafe.mockResolvedValue(null);
  searchMock.searchTrending.mockReset();
  searchMock.searchTrending.mockResolvedValue([]);
  summaryMock.loadRepoSummaries.mockReset();
  summaryMock.loadRepoSummaries.mockResolvedValue(new Map());
  dbMock.failExecute = false;
});

// ---------------------------------------------------------------------------
// formatSearchReply：纯函数，markdown 单行 + 链接 + 摘要注入，逐字符钉死。
// ---------------------------------------------------------------------------
describe('formatSearchReply（markdown 单行 + 链接 + 摘要注入）', () => {
  it('快照断言：编号、链接、★stars (+delta)、（新上榜）、简介与页脚逐字符钉死', () => {
    const items = [
      makeItem(),
      makeItem({
        fullName: 'rust-lang/rust',
        stars: 99000,
        starsDelta: 123,
        isNew: true,
      }),
    ];
    const summaries = new Map([
      ['vercel/next.js', 'React 全栈框架'],
      ['rust-lang/rust', '系统级编程语言'],
    ]);
    expect(formatSearchReply(items, summaries)).toBe(
      [
        '1. [vercel/next.js](https://github.com/vercel/next.js) ★128000 (+321) — React 全栈框架',
        '2. [rust-lang/rust](https://github.com/rust-lang/rust) ★99000 (+123)（新上榜） — 系统级编程语言',
        GUIDANCE_FOOTER,
      ].join('\n'),
    );
  });

  it('摘要 Map 缺失该仓库 → 省略破折号后段（不回退英文 description）', () => {
    const out = formatSearchReply(
      [makeItem({ fullName: 'x/blank', description: 'English desc' })],
      new Map(),
    );
    expect(out).toBe(
      [
        '1. [x/blank](https://github.com/x/blank) ★128000 (+321)',
        GUIDANCE_FOOTER,
      ].join('\n'),
    );
    expect(out).not.toContain('English desc');
    expect(out).not.toContain(' — ');
  });

  it('摘要含 markdown 特殊字符时被转义（防注入防错乱）', () => {
    const out = formatSearchReply(
      [makeItem({ fullName: 'a/b' })],
      new Map([['a/b', '支持 *通配* 与 [配置]']]),
    );
    expect(out).toContain(' — 支持 \\*通配\\* 与 \\[配置\\]');
  });

  it('isNew 为 false 时无（新上榜）标注', () => {
    const out = formatSearchReply([makeItem()], new Map());
    expect(out).not.toContain('新上榜');
  });

  it('编号从 1 起严格递增', () => {
    const out = formatSearchReply(
      [
        makeItem({ fullName: 'a/a' }),
        makeItem({ fullName: 'b/b' }),
        makeItem({ fullName: 'c/c' }),
      ],
      new Map(),
    );
    expect(out).toContain('1. [a/a](https://github.com/a/a)');
    expect(out).toContain('2. [b/b](https://github.com/b/b)');
    expect(out).toContain('3. [c/c](https://github.com/c/c)');
  });

  it('页脚固定在末尾，含「收藏」「帮助」两个指引关键词', () => {
    const out = formatSearchReply([makeItem()], new Map());
    expect(out.endsWith(GUIDANCE_FOOTER)).toBe(true);
    expect(GUIDANCE_FOOTER).toBe(
      '💡 直接回复「收藏 N」收藏任意一条；发「帮助」查看全部指令',
    );
  });

  it('空列表返回空串（空结果引导文案由 handleSearch 负责）', () => {
    expect(formatSearchReply([], new Map())).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatSearchReply 超长截断：markdown 上限 3800 字节（4096 的安全阈值）。
// ---------------------------------------------------------------------------
describe('formatSearchReply 超长截断（MAX_MARKDOWN_BYTES = 3800）', () => {
  function makeManyItems(count: number): SearchResultItem[] {
    return Array.from({ length: count }, (_, i) =>
      makeItem({
        fullName: `owner${i}/repo-${i}`,
      }),
    );
  }

  function longSummaries(count: number): Map<string, string> {
    return new Map(
      Array.from({ length: count }, (_, i) => [
        `owner${i}/repo-${i}`,
        `第 ${i} 个仓库的中文简介 padding padding padding padding padding`,
      ]),
    );
  }

  it('导出的上限常量为 3800 字节', () => {
    expect(MAX_MARKDOWN_BYTES).toBe(3800);
  });

  it('超过 3800 字节时截断列表、标注截断、保留页脚', () => {
    const out = formatSearchReply(makeManyItems(40), longSummaries(40));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(3800);
    expect(out).toContain('（结果过多，已截断）');
    expect(out).toContain(GUIDANCE_FOOTER);
  });

  it('截断保留靠前条目、丢弃靠后条目', () => {
    const out = formatSearchReply(makeManyItems(40), longSummaries(40));
    expect(out).toContain('1. [owner0/repo-0]');
    expect(out).not.toContain('owner39/repo-39');
  });

  it('未超阈值的短列表不带截断标注', () => {
    const out = formatSearchReply([makeItem()], new Map());
    expect(out).not.toContain('已截断');
  });
});

// ---------------------------------------------------------------------------
// handleSearch：parse → search →（空结果关键词回退）→ summaries → markdown 发送。
// ---------------------------------------------------------------------------
describe('handleSearch（全链：LLM 解析 → 检索 → 摘要 → markdown 发送）', () => {
  it('LLM 返回结构化查询 → 检索 2 条 → 注入摘要 → sendWeComMarkdown 发送', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ languages: ['python'], keywords: ['ai'] }),
    );
    const items = [
      makeItem({ fullName: 'alice/py-ai', stars: 1000, starsDelta: 100 }),
      makeItem({
        fullName: 'bob/rs-ai',
        stars: 2000,
        starsDelta: 200,
        isNew: true,
      }),
    ];
    searchMock.searchTrending.mockResolvedValue(items);
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map([['alice/py-ai', 'Python AI 框架']]),
    );

    await handleSearch(makeMsg({ content: '本周 python 的 ai 项目' }));

    // 解析产物进入检索调用（searchTrending(query, wecomUserId)）
    expect(searchMock.searchTrending).toHaveBeenCalledTimes(1);
    const [query] = searchMock.searchTrending.mock.calls[0] as [
      { languages: string[]; keywords: string[] },
    ];
    expect(query.languages).toEqual(['python']);
    expect(query.keywords).toEqual(['ai']);
    // 摘要按同一 items 注入
    expect(summaryMock.loadRepoSummaries).toHaveBeenCalledWith(items);
    // markdown 通道发送（而非 text）
    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledWith(
      'alice',
      [
        '1. [alice/py-ai](https://github.com/alice/py-ai) ★1000 (+100) — Python AI 框架',
        '2. [bob/rs-ai](https://github.com/bob/rs-ai) ★2000 (+200)（新上榜）',
        GUIDANCE_FOOTER,
      ].join('\n'),
    );
  });

  it('LLM 返回 null → fallbackParse 仍产生 keywords', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(null);
    searchMock.searchTrending.mockResolvedValue([
      makeItem({ fullName: 'alice/py-ai' }),
    ]);

    await handleSearch(makeMsg({ content: '本周 python 的 ai 项目' }));

    const [query] = searchMock.searchTrending.mock.calls[0] as [
      { languages: string[]; keywords: string[] },
    ];
    expect(query.languages).toEqual(['python']);
    expect(query.keywords).toEqual(['ai']);
    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledTimes(1);
  });

  it('首次检索空且 keywords 非空 → 去关键词重查一次（第二次 keywords 为空）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ languages: ['rust'], keywords: ['quantum'] }),
    );
    searchMock.searchTrending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeItem({ fullName: 'alice/rs-algo' })]);

    await handleSearch(makeMsg({ content: 'rust quantum' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(2);
    const first = searchMock.searchTrending.mock.calls[0]?.[0] as {
      keywords: string[];
      languages: string[];
    };
    const second = searchMock.searchTrending.mock.calls[1]?.[0] as {
      keywords: string[];
      languages: string[];
    };
    expect(first.keywords).toEqual(['quantum']);
    expect(second.keywords).toEqual([]);
    // 其余查询维度保持不变（只摘掉 keywords）
    expect(second.languages).toEqual(first.languages);
    // 回退命中后走 markdown 正常发送
    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).not.toHaveBeenCalled();
  });

  it('首次检索空且 keywords 为空 → 不重查，直接回引导文案（text）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    await handleSearch(makeMsg({ content: '啊' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
    expect(apiMock.sendWeComMarkdown).not.toHaveBeenCalled();
    expect(EMPTY_RESULT_REPLY).toContain('没找到');
  });

  it('两次检索都为空 → EMPTY_RESULT_REPLY（text）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ keywords: ['quantum'] }),
    );
    await handleSearch(makeMsg({ content: 'quantum 退火' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(2);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
    expect(apiMock.sendWeComMarkdown).not.toHaveBeenCalled();
  });

  it('loadRepoSummaries 抛错 → 降级为无简介列表照发（摘要失败不吞搜索结果）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    searchMock.searchTrending.mockResolvedValue([
      makeItem({ fullName: 'alice/py-ai' }),
    ]);
    summaryMock.loadRepoSummaries.mockRejectedValue(new Error('llm exploded'));

    await handleSearch(makeMsg({ content: 'python' }));

    expect(apiMock.sendWeComMarkdown).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComMarkdown.mock.calls[0] as [
      string,
      string,
    ];
    expect(content).toContain('[alice/py-ai](https://github.com/alice/py-ai)');
    expect(content).not.toContain(' — ');
  });

  it('检索抛错 → 发送友好错误文案（text）、记 handleSearch failed 日志，且不向上传播异常', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    searchMock.searchTrending.mockRejectedValue(new Error('db down'));
    await expect(
      handleSearch(makeMsg({ content: 'python' })),
    ).resolves.toBeUndefined();
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', ERROR_REPLY);
    expect(ERROR_REPLY).toContain('抱歉');
    expect(errorSpy).toHaveBeenCalledWith(
      'handleSearch failed:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('LLM 硬失败（generateObjectSafe reject）也被兜住 → 错误文案', async () => {
    llmMock.generateObjectSafe.mockRejectedValue(new Error('llm hard fail'));
    await expect(
      handleSearch(makeMsg({ content: 'python' })),
    ).resolves.toBeUndefined();
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', ERROR_REPLY);
  });

  it('sendWeComMarkdown 失败时兜底改发错误文案，兜底再失败则两条日志都记（运维可见）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    searchMock.searchTrending.mockResolvedValue([makeItem()]);
    apiMock.sendWeComMarkdown.mockRejectedValue(new Error('wecom down'));
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));
    await expect(
      handleSearch(makeMsg({ content: 'python' })),
    ).resolves.toBeUndefined();
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', ERROR_REPLY);
    expect(errorSpy).toHaveBeenCalledWith(
      'handleSearch failed:',
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'search error-reply send failed:',
      expect.objectContaining({ message: 'wecom down' }),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 注册进 router：普通文本消息经 routeMessage 落到 handleSearch。
// ---------------------------------------------------------------------------
describe('router 注册', () => {
  it('routeMessage 的普通文本经已注册的 handleSearch 走完整链路（空结果分支）', async () => {
    await routeMessage(makeMsg({ content: '随便搜点什么' }));
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
  });
});
