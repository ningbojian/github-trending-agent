import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 最近一次检索缓存：从 stars.ts 抽出，给「收藏 N」和「感兴趣/不感兴趣」共用。
 * 三态必须原样保留——「没有缓存」与「缓存为空」是两句不同的回复。
 */
const dbMock = vi.hoisted(() => ({
  rows: [] as Array<{ results: unknown }>,
  error: false,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              if (dbMock.error) throw new Error('db down');
              return dbMock.rows;
            },
          }),
        }),
      }),
    }),
  }),
}));

import { loadRecentResults } from '../src/agent/recent-results';

beforeEach(() => {
  dbMock.rows = [];
  dbMock.error = false;
});

describe('loadRecentResults', () => {
  it('从没搜索过 → found=false（调用方回「先搜索一次」而不是「没有第 N 条」）', async () => {
    await expect(loadRecentResults('u1')).resolves.toEqual({ found: false, items: [] });
  });

  it('有缓存行且结果非空 → found=true', async () => {
    dbMock.rows = [{ results: [{ fullName: 'a/b' }, { fullName: 'c/d' }] }];
    await expect(loadRecentResults('u1')).resolves.toEqual({
      found: true,
      items: [{ fullName: 'a/b' }, { fullName: 'c/d' }],
    });
  });

  it('有缓存行但结果是空数组 → found=true、items=[]（与「没搜过」区分开）', async () => {
    dbMock.rows = [{ results: [] }];
    await expect(loadRecentResults('u1')).resolves.toEqual({ found: true, items: [] });
  });

  it('results 形状坏掉 → 当作空结果，不抛', async () => {
    dbMock.rows = [{ results: 'garbage' }];
    await expect(loadRecentResults('u1')).resolves.toEqual({ found: true, items: [] });
  });

  it('读库失败向上抛（与抽取前一致，由 dispatchSafely 兜底）', async () => {
    dbMock.error = true;
    await expect(loadRecentResults('u1')).rejects.toThrow();
  });
});
