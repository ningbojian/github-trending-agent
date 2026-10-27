import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「感兴趣 / 不感兴趣」：作用于刚收到的那一批，不需要翻列表数序号。
 * 这里用真 taste.ts（只替身 db 与发消息），验证「回执文案」和「写进去的信号」对得上。
 */
const state = vi.hoisted(() => ({
  repoRows: [] as Array<{ fullName: string; language: string | null; topics: string[] }>,
  repoError: false,
  writeError: false,
  kv: new Map<string, { value: unknown; expiresAt: Date }>(),
  insertedTables: [] as string[],
  recent: { found: true, items: [] as Array<{ fullName: string }> },
  recentError: false,
}));

vi.mock('../src/db/client', async () => {
  const { kvCache, repos, searchCaches } = await import('../src/db/schema');
  return {
    db: () => ({
      select: () => ({
        from: (table: unknown) => {
          if (table === repos) {
            return {
              where: async () => {
                if (state.repoError) throw new Error('db down');
                return state.repoRows;
              },
            };
          }
          if (table === kvCache) {
            return {
              where: () => ({
                limit: async () => [...state.kv.values()].slice(0, 1),
              }),
            };
          }
          throw new Error('unexpected select table');
        },
      }),
      insert: (table: unknown) => ({
        values: (row: { key?: string; value?: unknown; expiresAt?: Date }) => {
          state.insertedTables.push(
            table === searchCaches ? 'search_caches' : table === kvCache ? 'kv_cache' : 'other',
          );
          if (state.writeError) throw new Error('db down');
          if (table === kvCache && row.key !== undefined) {
            state.kv.set(row.key, { value: row.value, expiresAt: row.expiresAt as Date });
          }
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    }),
  };
});

vi.mock('../src/agent/recent-results', () => ({
  loadRecentResults: async () => {
    if (state.recentError) throw new Error('db down');
    return state.recent;
  },
}));

vi.mock('../src/wecom/api', () => ({ sendWeComText: vi.fn() }));

import { composeSignals, readFeedback } from '../src/agent/taste';
import { sendWeComText } from '../src/wecom/api';
import {
  handleInterested,
  handleNotInterested,
  FEEDBACK_FAILED_REPLY,
} from '../src/wecom/feedback';
import { EMPTY_SEARCH_CACHE_REPLY, NO_SEARCH_CACHE_REPLY } from '../src/github/stars';
import type { InboundMessage } from '../src/wecom/router';

function message(content: string): InboundMessage {
  return {
    toUserName: 'corp',
    fromUserName: 'u1',
    createTime: 0,
    msgType: 'text',
    content,
    msgId: '1',
  };
}

const REPOS = [
  { fullName: 'a/go1', language: 'Go', topics: ['cli'] },
  { fullName: 'a/go2', language: 'Go', topics: ['cli'] },
  { fullName: 'a/rust1', language: 'Rust', topics: ['llm'] },
];

function recentItems(): Array<{ fullName: string }> {
  return REPOS.map((r) => ({ fullName: r.fullName }));
}

function sent(): string {
  const calls = vi.mocked(sendWeComText).mock.calls;
  return calls[calls.length - 1]?.[1] ?? '';
}

beforeEach(() => {
  state.repoRows = REPOS;
  state.repoError = false;
  state.writeError = false;
  state.kv.clear();
  state.insertedTables = [];
  state.recent = { found: true, items: recentItems() };
  state.recentError = false;
  vi.mocked(sendWeComText).mockClear();
});

describe('handleInterested', () => {
  it('回执点名方向（原始大小写），并写入一条 like 事件', async () => {
    await handleInterested(message('感兴趣'));

    expect(sent()).toBe('✅ 记下了：以后多推 Go、Rust 方向的项目。');
    const events = await readFeedback('u1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'like', languages: ['go', 'rust'] });
  });

  it('只写 kv_cache，绝不动 search_caches（「收藏 N」不能被口味打乱）', async () => {
    await handleInterested(message('感兴趣'));
    expect(state.insertedTables).toEqual(['kv_cache']);
  });

  it('语言全空 → 退化成通用文案，仍然记下反馈', async () => {
    state.recent = { found: true, items: [{ fullName: 'x/1' }] };
    state.repoRows = [{ fullName: 'x/1', language: null, topics: [] }];

    await handleInterested(message('感兴趣'));

    expect(sent()).toBe('✅ 记下了，会按这份简报的偏好多推同类项目。');
    expect(state.kv.size).toBe(1);
  });

  it('repos 查询失败 → 退化成通用文案，仍记下（只是没有方向）', async () => {
    state.repoError = true;
    await handleInterested(message('感兴趣'));
    expect(sent()).toBe('✅ 记下了，会按这份简报的偏好多推同类项目。');
    expect(state.kv.size).toBe(1);
  });

  it('写库失败 → 回执必须说「没记住」，不能谎报成功', async () => {
    state.writeError = true;
    await handleInterested(message('感兴趣'));
    expect(sent()).toBe(FEEDBACK_FAILED_REPLY);
  });
});

describe('handleNotInterested', () => {
  it('连提两次 → 该语言进 suppressed；只提一次不进（阈值恰好是 2）', async () => {
    await handleNotInterested(message('不感兴趣'));
    const once = composeSignals([], await readFeedback('u1'));
    expect(once.suppressed.size).toBe(0);

    await handleNotInterested(message('不感兴趣'));

    const events = await readFeedback('u1');
    expect(events).toHaveLength(2);
    const signals = composeSignals([], events);
    expect(signals.suppressed.has('go')).toBe(true);
  });

  it('回执写明「连提两次才会真正屏蔽」，不让规则变成隐藏行为', async () => {
    await handleNotInterested(message('不感兴趣'));
    expect(sent()).toBe('✅ 记下了：以后少推 Go、Rust 方向（连提两次才会真正屏蔽）。');
  });
});

describe('没有可反馈的列表', () => {
  it('从未搜索/收到简报 → 引导先有一次列表，不写任何表', async () => {
    state.recent = { found: false, items: [] };
    await handleInterested(message('感兴趣'));
    expect(sent()).toBe(NO_SEARCH_CACHE_REPLY);
    expect(state.insertedTables).toEqual([]);
  });

  it('上次结果为空 → 空态文案（与「没搜过」区分）', async () => {
    state.recent = { found: true, items: [] };
    await handleNotInterested(message('不感兴趣'));
    expect(sent()).toBe(EMPTY_SEARCH_CACHE_REPLY);
    expect(state.insertedTables).toEqual([]);
  });

  it('读缓存出错时向 dispatchSafely 抛（由它统一回「出错了」）', async () => {
    state.recentError = true;
    await expect(handleInterested(message('感兴趣'))).rejects.toThrow();
  });
});
