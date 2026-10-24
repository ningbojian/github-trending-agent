import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks：LLM / db 层 / config —— 不触网、不连库、不调 LLM。
// ---------------------------------------------------------------------------
const llmMock = vi.hoisted(() => ({
  generateObjectSafe: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  selectCalls: 0,
  selectRows: [] as Record<string, unknown>[],
  insertValues: [] as Record<string, unknown>[],
}));

const configMock = vi.hoisted(() => ({
  env: { REPO_SUMMARY_MODE: undefined as string | undefined },
}));

vi.mock('../src/agent/llm', () => ({
  generateObjectSafe: llmMock.generateObjectSafe,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          dbMock.selectCalls += 1;
          return dbMock.selectRows;
        },
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        dbMock.insertValues.push(...(arr as Record<string, unknown>[]));
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

vi.mock('../src/config', () => ({ env: configMock.env }));

import { loadRepoSummaries } from '../src/agent/repo-summary';

const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_TTL_MS = 180 * DAY_MS;

/** 构造一条 kv_cache 命中行（未过期）。 */
function cacheRow(
  fullName: string,
  zh: string,
  src: string,
  ttlMs: number = LONG_TTL_MS,
): Record<string, unknown> {
  return {
    key: `repo-zh:${fullName}`,
    value: { zh, src },
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectCalls = 0;
  dbMock.selectRows.length = 0;
  dbMock.insertValues.length = 0;
  configMock.env.REPO_SUMMARY_MODE = undefined;
  llmMock.generateObjectSafe.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// 缓存命中
// ---------------------------------------------------------------------------
describe('loadRepoSummaries — 缓存命中', () => {
  it('全命中：不调用 LLM，返回缓存 zh（src 与当前 description 一致）', async () => {
    dbMock.selectRows.push(
      cacheRow('a/one', '缓存简介一', 'desc one'),
      cacheRow('b/two', '缓存简介二', 'desc two'),
    );

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: 'desc one' },
      { fullName: 'b/two', description: 'desc two' },
    ]);

    expect(map.get('a/one')).toBe('缓存简介一');
    expect(map.get('b/two')).toBe('缓存简介二');
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(dbMock.insertValues).toHaveLength(0);
  });

  it('部分命中：只把 miss 放进 LLM 入参 prompt，命中项直接返回缓存 zh', async () => {
    dbMock.selectRows.push(cacheRow('a/one', '缓存一', 'desc one'));
    llmMock.generateObjectSafe.mockResolvedValue({
      summaries: [{ fullName: 'b/two', zh: '新生成简介' }],
    });

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: 'desc one' },
      { fullName: 'b/two', description: 'desc two' },
    ]);

    expect(map.get('a/one')).toBe('缓存一');
    expect(map.get('b/two')).toBe('新生成简介');
    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
    const prompt = String(llmMock.generateObjectSafe.mock.calls[0]?.[1]);
    expect(prompt).toContain('b/two');
    expect(prompt).toContain('desc two');
    expect(prompt).not.toContain('a/one');
  });

  it('src 变化：缓存失效，重新进 LLM 生成（prompt 带新 description）', async () => {
    dbMock.selectRows.push(cacheRow('a/one', '旧缓存', 'old desc'));
    llmMock.generateObjectSafe.mockResolvedValue({
      summaries: [{ fullName: 'a/one', zh: '重新生成的简介' }],
    });

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: 'new desc' },
    ]);

    expect(map.get('a/one')).toBe('重新生成的简介');
    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
    const prompt = String(llmMock.generateObjectSafe.mock.calls[0]?.[1]);
    expect(prompt).toContain('new desc');
  });

  it('已过期（expiresAt <= now）的行视为未命中，重新生成', async () => {
    dbMock.selectRows.push({
      key: 'repo-zh:a/one',
      value: { zh: '过期缓存', src: 'desc one' },
      expiresAt: new Date(Date.now() - 1000),
    });
    llmMock.generateObjectSafe.mockResolvedValue({
      summaries: [{ fullName: 'a/one', zh: '新鲜简介' }],
    });

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: 'desc one' },
    ]);

    expect(map.get('a/one')).toBe('新鲜简介');
    expect(llmMock.generateObjectSafe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// LLM 失败降级
// ---------------------------------------------------------------------------
describe('loadRepoSummaries — LLM 失败降级', () => {
  it('LLM 返回 null：降级 description 截断 40 字符，并以约 1 天短 TTL 写缓存；无 description 不入 Map 不写缓存', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    try {
      llmMock.generateObjectSafe.mockResolvedValue(null);
      const longDesc =
        'A rather long English description that definitely exceeds forty characters limit.';

      const map = await loadRepoSummaries([
        { fullName: 'a/one', description: longDesc },
        { fullName: 'b/two', description: null },
      ]);

      expect(map.get('a/one')).toBe(longDesc.slice(0, 40));
      expect(map.has('b/two')).toBe(false);

      expect(dbMock.insertValues).toHaveLength(1);
      const written = dbMock.insertValues[0]!;
      expect(written.key).toBe('repo-zh:a/one');
      expect(written.value).toEqual({ zh: longDesc.slice(0, 40), src: longDesc });
      // expiresAt ≈ now + 1 天（冻结时钟下精确相等）
      expect((written.expiresAt as Date).getTime()).toBe(Date.now() + DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('LLM 抛错（违反 never-reject 契约）：同样降级截断 + 短 TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    try {
      llmMock.generateObjectSafe.mockRejectedValue(new Error('llm exploded'));
      const desc = 'English description used for degradation path testing.';

      const map = await loadRepoSummaries([
        { fullName: 'a/one', description: desc },
      ]);

      expect(map.get('a/one')).toBe(desc.slice(0, 40));
      expect(dbMock.insertValues).toHaveLength(1);
      expect((dbMock.insertValues[0]!.expiresAt as Date).getTime()).toBe(
        Date.now() + DAY_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 中文 description 与 off 开关
// ---------------------------------------------------------------------------
describe('loadRepoSummaries — 中文直取与 REPO_SUMMARY_MODE=off', () => {
  it('中文 description（CJK 占非空白字符 ≥30%）不调 LLM，截断 28 字并以长 TTL 写缓存', async () => {
    const zhDesc =
      '一个用 Rust 编写的高性能终端工具，支持丰富的插件扩展与主题定制功能。这个描述比较长以便验证 28 字截断行为。';

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: zhDesc },
    ]);

    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(map.get('a/one')).toBe(
      Array.from(zhDesc).slice(0, 28).join(''),
    );
    expect(dbMock.insertValues).toHaveLength(1);
    const written = dbMock.insertValues[0]!;
    expect(written.key).toBe('repo-zh:a/one');
    const ttl = (written.expiresAt as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(LONG_TTL_MS - 5000);
    expect(ttl).toBeLessThanOrEqual(LONG_TTL_MS);
  });

  it('REPO_SUMMARY_MODE=off：完全不调 LLM，全部走 description 截断（短 TTL），无 description 不入 Map', async () => {
    configMock.env.REPO_SUMMARY_MODE = 'off';
    const desc = 'English description that would normally be translated by LLM.';

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: desc },
      { fullName: 'b/two', description: null },
    ]);

    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(map.get('a/one')).toBe(desc.slice(0, 40));
    expect(map.has('b/two')).toBe(false);
    expect(dbMock.insertValues).toHaveLength(1);
    const ttl =
      (dbMock.insertValues[0]!.expiresAt as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(DAY_MS - 5000);
    expect(ttl).toBeLessThanOrEqual(DAY_MS);
  });

  it('REPO_SUMMARY_MODE=off 时中文 description 仍走 28 字直取（长 TTL），不调 LLM', async () => {
    configMock.env.REPO_SUMMARY_MODE = 'off';
    const zhDesc = '用 Go 编写的高性能分布式消息队列系统';

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: zhDesc },
    ]);

    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(map.get('a/one')).toBe(zhDesc);
    const ttl =
      (dbMock.insertValues[0]!.expiresAt as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(LONG_TTL_MS - 5000);
  });
});

// ---------------------------------------------------------------------------
// 空输入 / 返回值对齐
// ---------------------------------------------------------------------------
describe('loadRepoSummaries — 边界', () => {
  it('空输入：直接返回空 Map，不查库、不调 LLM、不写缓存', async () => {
    const map = await loadRepoSummaries([]);

    expect(map.size).toBe(0);
    expect(dbMock.selectCalls).toBe(0);
    expect(llmMock.generateObjectSafe).not.toHaveBeenCalled();
    expect(dbMock.insertValues).toHaveLength(0);
  });

  it('返回值 Map 的 key 与输入 fullName 对齐（LLM 成功 + 降级混合）', async () => {
    llmMock.generateObjectSafe.mockResolvedValue({
      summaries: [{ fullName: 'a/one', zh: '生成简介' }],
    });
    const fallbackDesc = 'Fallback English description for degradation.';

    const map = await loadRepoSummaries([
      { fullName: 'a/one', description: 'desc one' },
      { fullName: 'b/two', description: fallbackDesc },
      { fullName: 'c/three', description: null },
    ]);

    expect([...map.keys()].sort()).toEqual(['a/one', 'b/two']);
    expect(map.get('a/one')).toBe('生成简介');
    expect(map.get('b/two')).toBe(fallbackDesc.slice(0, 40));
  });

  it('LLM 成功：以长 TTL（180 天）回写 kv_cache，src 存当前 description', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    try {
      llmMock.generateObjectSafe.mockResolvedValue({
        summaries: [{ fullName: 'a/one', zh: '终端神器' }],
      });

      await loadRepoSummaries([{ fullName: 'a/one', description: 'desc one' }]);

      expect(dbMock.insertValues).toHaveLength(1);
      const written = dbMock.insertValues[0]!;
      expect(written.value).toEqual({ zh: '终端神器', src: 'desc one' });
      expect((written.expiresAt as Date).getTime()).toBe(
        Date.now() + LONG_TTL_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
