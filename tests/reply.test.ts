import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/wecom/router';

// ---------------------------------------------------------------------------
// Mocks：api / LLM / searchTrending / loadRepoSummaries / db —— 绝不触网、不连库。
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
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

const userLlmMock = vi.hoisted(() => ({
  loadUserLlm: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  failExecute: false,
  insertValues: [] as Record<string, unknown>[],
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
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

vi.mock('../src/agent/user-llm', () => ({
  loadUserLlm: userLlmMock.loadUserLlm,
}));

// db 兜底 mock：router 的 stars/onboarding 模块图需要 db 导出存在（本文件不经其路径）。
// insert 供匿名意图日志（intent-log）走真实实现，断言落库形状。
vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async () => {
      if (dbMock.failExecute) {
        throw new Error('db down');
      }
      return { rows: [] };
    },
    insert: () => ({
      values: (row: unknown) => {
        dbMock.insertValues.push(row as Record<string, unknown>);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

import type { SearchResultItem } from '../src/agent/search';
import {
  EMPTY_RESULT_REPLY,
  ERROR_REPLY,
  GUIDANCE_FOOTER,
  MAX_TEXT_BYTES,
  formatSearchReply,
  handleSearch,
} from '../src/wecom/reply';
import { ABOUT_REPLY, OFF_TOPIC_REPLY } from '../src/wecom/onboarding';
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
  intent: 'search' | 'about' | 'off_topic';
  languages: string[];
  keywords: string[];
  period: 'today' | 'week' | 'month' | 'all';
  minStars: number | null;
  sortBy: 'stars_delta' | 'stars' | 'new';
  topN: number;
}> = {}) {
  return {
    intent: 'search' as const,
    languages: [],
    keywords: [],
    period: 'week',
    minStars: null,
    sortBy: 'stars_delta',
    topN: 10,
    ...overrides,
  };
}

/** 用户自备 LLM 配置（单元测试假值）。 */
const USER_LLM = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-unit-test-00000000',
};

beforeEach(() => {
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  llmMock.generateObjectSafe.mockReset();
  llmMock.generateObjectSafe.mockResolvedValue(null);
  searchMock.searchTrending.mockReset();
  searchMock.searchTrending.mockResolvedValue([]);
  summaryMock.loadRepoSummaries.mockReset();
  summaryMock.loadRepoSummaries.mockResolvedValue(new Map());
  // 默认「用户已配好自己的 Key」：既有用例都是「LLM 路径」的断言。
  userLlmMock.loadUserLlm.mockReset();
  userLlmMock.loadUserLlm.mockResolvedValue(USER_LLM);
  dbMock.failExecute = false;
  dbMock.insertValues = [];
});

// ---------------------------------------------------------------------------
// formatSearchReply：纯函数，纯文本单行 + 裸链接 + 摘要注入，逐字符钉死。
// ---------------------------------------------------------------------------
describe('formatSearchReply（纯文本单行 + 裸链接 + 摘要注入）', () => {
  it('快照断言：编号、仓库名、★stars (+delta)、（新上榜）、简介、链接与页脚逐字符钉死', () => {
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
        '1. vercel/next.js ★128000 (+321) — React 全栈框架 https://github.com/vercel/next.js',
        '2. rust-lang/rust ★99000 (+123)（新上榜） — 系统级编程语言 https://github.com/rust-lang/rust',
        GUIDANCE_FOOTER,
      ].join('\n'),
    );
  });

  it('消息里不得出现 markdown 链接语法（微信侧看不到 markdown）', () => {
    const out = formatSearchReply([makeItem()], new Map());
    expect(out).not.toContain('](');
    expect(out).toContain('https://github.com/vercel/next.js');
  });

  it('摘要 Map 缺失该仓库 → 省略破折号后段（不回退英文 description）', () => {
    const out = formatSearchReply(
      [makeItem({ fullName: 'x/blank', description: 'English desc' })],
      new Map(),
    );
    expect(out).toBe(
      [
        '1. x/blank ★128000 (+321) https://github.com/x/blank',
        GUIDANCE_FOOTER,
      ].join('\n'),
    );
    expect(out).not.toContain('English desc');
    expect(out).not.toContain(' — ');
  });

  it('摘要里的 Markdown 特殊字符原样保留（纯文本无需转义）', () => {
    const out = formatSearchReply(
      [makeItem({ fullName: 'a/b' })],
      new Map([['a/b', '支持 *通配* 与 [配置]']]),
    );
    expect(out).toContain(' — 支持 *通配* 与 [配置]');
    expect(out).not.toContain('\\');
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
    expect(out).toContain('1. a/a');
    expect(out).toContain('2. b/b');
    expect(out).toContain('3. c/c');
  });

  it('页脚固定在末尾，教会「序号精确反馈」', () => {
    const out = formatSearchReply([makeItem()], new Map());
    expect(out.endsWith(GUIDANCE_FOOTER)).toBe(true);
    expect(GUIDANCE_FOOTER).toBe(
      '💡 「收藏 3」收藏第 3 条；「不感兴趣 3」只针对它；发「帮助」看全部指令',
    );
  });

  it('空列表返回空串（空结果引导文案由 handleSearch 负责）', () => {
    expect(formatSearchReply([], new Map())).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatSearchReply 超长截断：企微文本消息上限 2048 字节，安全阈值 1900。
// ---------------------------------------------------------------------------
describe(`formatSearchReply 超长截断（MAX_TEXT_BYTES = ${MAX_TEXT_BYTES}）`, () => {
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

  it('导出的上限常量为 1900 字节：低于企微文本消息 2048 字节的内容上限', () => {
    expect(MAX_TEXT_BYTES).toBe(1900);
    expect(MAX_TEXT_BYTES).toBeLessThan(2048);
  });

  it('超过上限时截断列表、标注截断、保留页脚', () => {
    const out = formatSearchReply(makeManyItems(40), longSummaries(40));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(out).toContain('（结果过多，已截断）');
    expect(out).toContain(GUIDANCE_FOOTER);
  });

  it('截断保留靠前条目、丢弃靠后条目', () => {
    const out = formatSearchReply(makeManyItems(40), longSummaries(40));
    expect(out).toContain('1. owner0/repo-0');
    expect(out).not.toContain('owner39/repo-39');
  });

  it('未超阈值的短列表不带截断标注', () => {
    const out = formatSearchReply([makeItem()], new Map());
    expect(out).not.toContain('已截断');
  });
});

// ---------------------------------------------------------------------------
// handleSearch：parse → search →（空结果关键词回退）→ summaries → 文本发送。
// ---------------------------------------------------------------------------
describe('handleSearch（全链：LLM 解析 → 检索 → 摘要 → 文本发送）', () => {
  it('LLM 返回结构化查询 → 检索 2 条 → 注入摘要 → sendWeComText 发送', async () => {
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
    // 摘要按同一 items 注入，且用的是用户自己的 Key（不烧运营方额度）
    expect(summaryMock.loadRepoSummaries).toHaveBeenCalledWith(items, {
      kind: 'user',
      config: USER_LLM,
    });
    // 只走文本通道（markdown 在微信里不可见）
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      [
        '1. alice/py-ai ★1000 (+100) — Python AI 框架 https://github.com/alice/py-ai',
        '2. bob/rs-ai ★2000 (+200)（新上榜） https://github.com/bob/rs-ai',
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
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
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
    // 回退命中后正常发送一次
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
  });

  it('首次检索空且 keywords 为空 → 不重查，直接回引导文案', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    await handleSearch(makeMsg({ content: '啊' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
    expect(EMPTY_RESULT_REPLY).toContain('没找到');
  });

  it('两次检索都为空 → EMPTY_RESULT_REPLY', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ keywords: ['quantum'] }),
    );
    await handleSearch(makeMsg({ content: 'quantum 退火' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(2);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
  });

  it('摘要含换行 → 渲染边界折叠：发送内容中无以 > 开头的引用行', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    searchMock.searchTrending.mockResolvedValue([
      makeItem({ fullName: 'a/b' }),
    ]);
    summaryMock.loadRepoSummaries.mockResolvedValue(
      new Map([['a/b', 'Cool tool\n> 领取内测名额']]),
    );

    await handleSearch(makeMsg({ content: 'python' }));

    const [, content] = apiMock.sendWeComText.mock.calls[0] as [
      string,
      string,
    ];
    expect(content).toContain(' — Cool tool > 领取内测名额');
    expect(content.split('\n').some((line) => line.startsWith('> '))).toBe(
      false,
    );
  });

  it('loadRepoSummaries 抛错 → 降级为无简介列表照发（摘要失败不吞搜索结果）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    searchMock.searchTrending.mockResolvedValue([
      makeItem({ fullName: 'alice/py-ai' }),
    ]);
    summaryMock.loadRepoSummaries.mockRejectedValue(new Error('llm exploded'));

    await handleSearch(makeMsg({ content: 'python' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    const [, content] = apiMock.sendWeComText.mock.calls[0] as [
      string,
      string,
    ];
    expect(content).toContain('alice/py-ai');
    expect(content).toContain('https://github.com/alice/py-ai');
    expect(content).not.toContain(' — ');
  });

  it('检索抛错 → 发送友好错误文案、记 handleSearch failed 日志，且不向上传播异常', async () => {
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

  it('列表发送失败时兜底改发错误文案，兜底再失败则两条日志都记（运维可见）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    searchMock.searchTrending.mockResolvedValue([makeItem()]);
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
// 意图边界：about / off_topic 只回文案，绝不检索、绝不写 search_caches。
// 「收藏 N」只应指向最后一次真实列表，所以边界分支连 searchTrending 都不能碰。
// ---------------------------------------------------------------------------
describe('handleSearch 意图边界（about / off_topic 不检索）', () => {
  async function expectNoSearch(): Promise<void> {
    expect(searchMock.searchTrending).not.toHaveBeenCalled();
    expect(summaryMock.loadRepoSummaries).not.toHaveBeenCalled();
  }

  it('规则命中 about（「你是谁」）→ 回产品介绍，不调模型、不检索', async () => {
    await handleSearch(makeMsg({ content: '你是谁' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', ABOUT_REPLY);
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    await expectNoSearch();
  });

  it('规则命中 off_topic（「今天天气怎么样」）→ 回边界引导，不调模型、不检索', async () => {
    await handleSearch(makeMsg({ content: '今天天气怎么样' }));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', OFF_TOPIC_REPLY);
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    await expectNoSearch();
  });

  it('长句规则拿不准 → 交给 LLM；LLM 判 about 也不检索', async () => {
    const content = '麻烦你认真介绍一下你自己到底是做什么用的呢';
    expect(content.length).toBeGreaterThan(20);
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery({ intent: 'about' }));

    await handleSearch(makeMsg({ content }));

    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith('alice', ABOUT_REPLY);
    await expectNoSearch();
  });

  it('LLM 判 off_topic（「明天下雨吗」这类换过说法的长句）→ 不检索', async () => {
    const content = '能不能帮我查一下明天上午的天气情况会不会下雨呢';
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ intent: 'off_topic' }),
    );

    await handleSearch(makeMsg({ content }));

    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      OFF_TOPIC_REPLY,
    );
    await expectNoSearch();
  });

  it('intent 缺失（旧解析产物/fallback）按搜索处理，行为不变', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    searchMock.searchTrending.mockResolvedValue([
      makeItem({ fullName: 'a/b' }),
    ]);

    await handleSearch(makeMsg({ content: 'python 热榜' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 匿名意图日志：只记规则层没学到的样本（规则漏判 / 0 结果 / ≤10 字短句）。
// ---------------------------------------------------------------------------
describe('handleSearch 匿名意图日志', () => {
  /**
   * 同一次调用还会写 parse 缓存（parse:v1:*），所以只看 intent-miss 那几行。
   */
  function missRows(): Array<{ key: string; value: Record<string, unknown> }> {
    return dbMock.insertValues.filter((row) =>
      String(row.key).startsWith('intent-miss:'),
    ) as Array<{ key: string; value: Record<string, unknown> }>;
  }

  it('LLM 判 off_topic（规则漏判）→ 记一条匿名样本', async () => {
    // >30 字：规则只认短句，这句必须落到模型手里才判得出来。
    const content = '麻烦你帮我看看明天上午上海的天气怎么样会不会下雨需不需要带伞出门';
    expect(content.length).toBeGreaterThan(30);
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ intent: 'off_topic' }),
    );

    await handleSearch(makeMsg({ content }));

    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
    const rows = missRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toMatch(/^intent-miss:\d{8}:[0-9a-f]{40}$/);
    // 只存原话与最终意图——不含 userid 等任何身份字段。
    expect(rows[0].value).toEqual({ text: content, final: 'off_topic' });
  });

  it('规则命中 off_topic → 不记（这句话规则已经认识）', async () => {
    await handleSearch(makeMsg({ content: '今天天气怎么样' }));

    expect(missRows()).toHaveLength(0);
  });

  it('正常搜索（有结果、且不是短句）→ 不记', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(
      makeQuery({ languages: ['python'], keywords: ['ai'] }),
    );
    searchMock.searchTrending.mockResolvedValue([makeItem()]);

    await handleSearch(makeMsg({ content: '本周 python 的 ai 项目' }));

    expect(searchMock.searchTrending).toHaveBeenCalledTimes(1);
    expect(missRows()).toHaveLength(0);
  });

  it('搜出来 0 条 → 记（多半是没听懂用户想搜什么）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    searchMock.searchTrending.mockResolvedValue([]);

    await handleSearch(makeMsg({ content: '那个最近很火的那个啥来着' }));

    const rows = missRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].value.final).toBe('search');
  });
});

// ---------------------------------------------------------------------------
// Token 归属：互动用用户自己的 Key；没配就零调用（规则解析 + 只读缓存）。
// ---------------------------------------------------------------------------
describe('handleSearch Token 归属', () => {
  it('配好自己的 Key → 解析与简介都带上该配置（烧用户额度）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(makeQuery());
    searchMock.searchTrending.mockResolvedValue([makeItem({ fullName: 'a/b' })]);

    await handleSearch(makeMsg({ content: 'python 热榜' }));

    expect(userLlmMock.loadUserLlm).toHaveBeenCalledWith('alice');
    expect(llmMock.generateObjectSafe.mock.calls[0]?.[2]).toEqual(USER_LLM);
    expect(summaryMock.loadRepoSummaries).toHaveBeenCalledWith(
      expect.any(Array),
      { kind: 'user', config: USER_LLM },
    );
  });

  it('没配 Key → 一次模型都不调，列表照常回（零成本）', async () => {
    userLlmMock.loadUserLlm.mockResolvedValue(null);
    searchMock.searchTrending.mockResolvedValue([makeItem({ fullName: 'a/b' })]);

    await handleSearch(makeMsg({ content: '本周 python 的 ai 项目' }));

    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(summaryMock.loadRepoSummaries).toHaveBeenCalledWith(
      expect.any(Array),
      { kind: 'none' },
    );
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(String(apiMock.sendWeComText.mock.calls[0]?.[1])).toContain('1. a/b');
  });

  it('没配 Key 时规则解析仍能识别语言与关键词（不至于完全退化）', async () => {
    userLlmMock.loadUserLlm.mockResolvedValue(null);
    searchMock.searchTrending.mockResolvedValue([makeItem({ fullName: 'a/b' })]);

    await handleSearch(makeMsg({ content: '本周 python 的 ai 项目' }));

    const [query] = searchMock.searchTrending.mock.calls[0] as [
      { languages: string[]; keywords: string[] },
    ];
    expect(query.languages).toEqual(['python']);
    expect(query.keywords).toEqual(['ai']);
  });

  it('规则命中的边界分支不查用户配置（不必为无关消息读库）', async () => {
    await handleSearch(makeMsg({ content: '你是谁' }));

    expect(userLlmMock.loadUserLlm).not.toHaveBeenCalled();
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
