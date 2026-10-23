import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/wecom/router';

// ---------------------------------------------------------------------------
// Mocks：sendWeComText / LLM（generateObjectSafe）/ db 层 —— 绝不触网、不连库。
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => ({
  sendWeComText: vi.fn(),
}));

const llmMock = vi.hoisted(() => ({
  generateObjectSafe: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  executeRows: [] as Record<string, unknown>[],
  executeQueries: [] as unknown[],
  failExecute: false,
}));

vi.mock('../src/wecom/api', () => ({
  sendWeComText: apiMock.sendWeComText,
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: llmMock.generateObjectSafe,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    execute: async (query: unknown) => {
      dbMock.executeQueries.push(query);
      if (dbMock.failExecute) {
        throw new Error('db down');
      }
      return { rows: dbMock.executeRows };
    },
    delete: () => ({ where: async () => undefined }),
    insert: () => ({ values: async () => undefined }),
  }),
}));

import type { SearchResultItem } from '../src/agent/search';
import {
  EMPTY_RESULT_REPLY,
  ERROR_REPLY,
  FAVORITE_HINT,
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

beforeEach(() => {
  apiMock.sendWeComText.mockReset();
  apiMock.sendWeComText.mockResolvedValue(undefined);
  llmMock.generateObjectSafe.mockReset();
  llmMock.generateObjectSafe.mockResolvedValue(null);
  dbMock.executeRows = [];
  dbMock.executeQueries = [];
  dbMock.failExecute = false;
});

// ---------------------------------------------------------------------------
// formatSearchReply：纯函数，编号列表 + 固定提示语，逐字符钉死。
// ---------------------------------------------------------------------------
describe('formatSearchReply（编号列表 + 固定提示语）', () => {
  it('快照断言：编号、★stars (+delta)、（新上榜）标注与末尾提示语逐字符钉死', () => {
    const items = [
      makeItem(),
      makeItem({
        fullName: 'rust-lang/rust',
        stars: 99000,
        starsDelta: 123,
        isNew: true,
        description: 'Empowering everyone',
      }),
    ];
    expect(formatSearchReply(items)).toBe(
      [
        '1. vercel/next.js ★128000 (+321) — The React Framework',
        '2. rust-lang/rust ★99000 (+123)（新上榜） — Empowering everyone',
        "回复'收藏 N'可收藏并同步 star",
      ].join('\n'),
    );
  });

  it('description 为 null 时省略破折号后段（整行不出现 " — "）', () => {
    const out = formatSearchReply([
      makeItem({ fullName: 'x/blank', description: null }),
    ]);
    expect(out).toBe(['1. x/blank ★128000 (+321)', FAVORITE_HINT].join('\n'));
    expect(out).not.toContain(' — ');
  });

  it('isNew 为 false 时无（新上榜）标注', () => {
    const out = formatSearchReply([makeItem()]);
    expect(out).not.toContain('新上榜');
  });

  it('编号从 1 起严格递增', () => {
    const out = formatSearchReply([
      makeItem({ fullName: 'a/a' }),
      makeItem({ fullName: 'b/b' }),
      makeItem({ fullName: 'c/c' }),
    ]);
    expect(out).toContain('1. a/a');
    expect(out).toContain('2. b/b');
    expect(out).toContain('3. c/c');
  });

  it('提示语固定在末尾', () => {
    const out = formatSearchReply([makeItem()]);
    expect(out.endsWith(FAVORITE_HINT)).toBe(true);
    expect(FAVORITE_HINT).toBe("回复'收藏 N'可收藏并同步 star");
  });

  it('空列表返回空串（空结果引导文案由 handleSearch 负责）', () => {
    expect(formatSearchReply([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatSearchReply 超长截断：企微文本上限 ~2048 字节，1800 字节安全阈值。
// ---------------------------------------------------------------------------
describe('formatSearchReply 超长截断', () => {
  function makeManyItems(count: number): SearchResultItem[] {
    return Array.from({ length: count }, (_, i) =>
      makeItem({
        fullName: `owner${i}/repo-${i}`,
        description:
          `第 ${i} 个很长的仓库描述用来撑爆字节上限 ` +
          'padding padding padding padding padding',
      }),
    );
  }

  it('超过 1800 字节时截断列表、标注截断、保留提示语', () => {
    const out = formatSearchReply(makeManyItems(40));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1800);
    expect(out).toContain('已截断');
    expect(out).toContain(FAVORITE_HINT);
  });

  it('截断保留靠前条目、丢弃靠后条目', () => {
    const out = formatSearchReply(makeManyItems(40));
    expect(out).toContain('1. owner0/repo-0');
    expect(out).not.toContain('owner39/repo-39');
  });

  it('未超阈值的短列表不带截断标注', () => {
    const out = formatSearchReply([makeItem()]);
    expect(out).not.toContain('已截断');
  });
});

// ---------------------------------------------------------------------------
// handleSearch：parse → search → format → sendWeComText 全链（全 mock）。
// ---------------------------------------------------------------------------
describe('handleSearch（全链：LLM → 回退解析 → 检索 → 格式化 → 发送）', () => {
  it('LLM 返回 null → 回退解析 → 检索 2 条 → 发送格式化文本给消息发送者', async () => {
    llmMock.generateObjectSafe.mockResolvedValue(null);
    dbMock.executeRows = [
      {
        fullName: 'alice/py-ai',
        description: 'Python AI framework',
        language: 'python',
        stars: 1000,
        starsDelta: 100,
        isNew: false,
        date: '2026-10-22',
        htmlUrl: 'https://github.com/alice/py-ai',
        rank: 1,
      },
      {
        fullName: 'bob/rs-ai',
        description: 'Rust AI toolkit',
        language: 'rust',
        stars: 2000,
        starsDelta: 200,
        isNew: true,
        date: '2026-10-22',
        htmlUrl: 'https://github.com/bob/rs-ai',
        rank: 2,
      },
    ];

    await handleSearch(makeMsg({ content: '本周 python 的 ai 项目' }));

    // LLM 被咨询过且返回 null → parseSearchQuery 走 fallbackParse
    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
    // 回退解析的产物（languages=['python']、keywords=['ai']）进入了检索 SQL 参数
    const executed = new PgDialect().sqlToQuery(
      dbMock.executeQueries[0] as SQL,
    );
    expect(executed.params).toContain('python');
    expect(executed.params).toContain('%ai%');
    // 2 条结果格式化后发给 fromUserName
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      [
        '1. alice/py-ai ★1000 (+100) — Python AI framework',
        '2. bob/rs-ai ★2000 (+200)（新上榜） — Rust AI toolkit',
        "回复'收藏 N'可收藏并同步 star",
      ].join('\n'),
    );
  });

  it('检索无结果 → 发送「没找到…换个说法」引导文案（中文）', async () => {
    dbMock.executeRows = [];
    await handleSearch(makeMsg({ content: '量子退火 rust' }));
    expect(apiMock.sendWeComText).toHaveBeenCalledTimes(1);
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
    expect(EMPTY_RESULT_REPLY).toContain('没找到');
    expect(EMPTY_RESULT_REPLY).toContain('换个说法');
  });

  it('检索抛错 → 发送友好错误文案、记 handleSearch failed 日志，且不向上传播异常', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.failExecute = true;
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

  it('sendWeComText 本身也失败时吞掉不向上传播，且两条日志都记（运维可见）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.failExecute = true;
    apiMock.sendWeComText.mockRejectedValue(new Error('wecom down'));
    await expect(
      handleSearch(makeMsg({ content: 'python' })),
    ).resolves.toBeUndefined();
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
    dbMock.executeRows = [];
    await routeMessage(makeMsg({ content: '随便搜点什么' }));
    expect(apiMock.sendWeComText).toHaveBeenCalledWith(
      'alice',
      EMPTY_RESULT_REPLY,
    );
  });
});
