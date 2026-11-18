import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DUE_STATE_EPOCH_KEY,
  DUE_STATE_TAG,
  isInDueWindow,
  invalidateDueState,
  probeDue,
  refreshDueState,
  type DueState,
} from '../src/agent/due-state-cache';

const cacheMock = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  get: vi.fn(async (key: string) => cacheMock.store.get(key) ?? null),
  set: vi.fn(async (key: string, value: unknown, _options?: unknown) => {
    cacheMock.store.set(key, value);
  }),
  expireTag: vi.fn(async (_tag: string | string[]) => {}),
  throwOnGet: false,
  throwOnSet: false,
  throwOnExpire: false,
}));

vi.mock('@vercel/functions', () => ({
  getCache: () => ({
    get: async (key: string) => {
      if (cacheMock.throwOnGet) throw new Error('cache down');
      return cacheMock.get(key);
    },
    set: async (key: string, value: unknown, options?: unknown) => {
      if (cacheMock.throwOnSet) throw new Error('cache down');
      return cacheMock.set(key, value, options);
    },
    expireTag: async (tag: string | string[]) => {
      if (cacheMock.throwOnExpire) throw new Error('cache down');
      return cacheMock.expireTag(tag);
    },
  }),
}));

const dueMock = vi.hoisted(() => ({
  readDueSnapshot: vi.fn(async () => ({
    dueNow: false,
    windows: [] as Array<{ start: number; end: number }>,
  })),
  anyDigestDue: vi.fn(async () => false),
}));

vi.mock('../src/agent/digest-due', () => ({
  readDueSnapshot: dueMock.readDueSnapshot,
  anyDigestDue: dueMock.anyDigestDue,
}));

/** 2026-11-01 10:00 北京时间（02:00Z）。 */
const NOW = new Date('2026-11-01T02:00:00.000Z');
const STATE_KEY = 'due-state:v1:2026-11-01';

function state(overrides: Partial<DueState> = {}): DueState {
  return {
    version: 1,
    date: '2026-11-01',
    generatedAt: NOW.toISOString(),
    windows: [{ start: 540, end: 1080 }],
    ...overrides,
  };
}

beforeEach(() => {
  cacheMock.store.clear();
  cacheMock.get.mockClear();
  cacheMock.set.mockClear();
  cacheMock.expireTag.mockClear();
  cacheMock.throwOnGet = false;
  cacheMock.throwOnSet = false;
  cacheMock.throwOnExpire = false;
  dueMock.readDueSnapshot.mockReset();
  dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });
  dueMock.anyDigestDue.mockReset();
  dueMock.anyDigestDue.mockResolvedValue(false);
});

describe('isInDueWindow', () => {
  const dueState = state({ windows: [{ start: 600, end: 660 }] });

  it('窗口起点包含、终点不包含', () => {
    expect(isInDueWindow(dueState, new Date('2026-11-01T01:59:00.000Z'))).toBe(false);
    expect(isInDueWindow(dueState, new Date('2026-11-01T02:00:00.000Z'))).toBe(true);
    expect(isInDueWindow(dueState, new Date('2026-11-01T02:59:00.000Z'))).toBe(true);
    expect(isInDueWindow(dueState, new Date('2026-11-01T03:00:00.000Z'))).toBe(false);
  });

  it('跨多个窗口只命中其中一个也算', () => {
    const multi = state({ windows: [{ start: 540, end: 600 }, { start: 900, end: 960 }] });
    expect(isInDueWindow(multi, new Date('2026-11-01T07:00:00.000Z'))).toBe(true); // 15:00
    expect(isInDueWindow(multi, new Date('2026-11-01T06:00:00.000Z'))).toBe(false); // 14:00
  });
});

describe('probeDue — 缓存命中', () => {
  it('不在窗口内 → 不查库', async () => {
    cacheMock.store.set(STATE_KEY, state({ windows: [{ start: 540, end: 600 }] }));

    await expect(probeDue(NOW)).resolves.toEqual({
      due: false,
      checked: false,
      cache: 'hit',
      window: false,
    });
    expect(dueMock.readDueSnapshot).not.toHaveBeenCalled();
    expect(dueMock.anyDigestDue).not.toHaveBeenCalled();
  });

  it('在窗口内 → 用数据库做最终裁决', async () => {
    cacheMock.store.set(STATE_KEY, state());
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: true, windows: [{ start: 540, end: 1080 }] });

    await expect(probeDue(NOW)).resolves.toEqual({
      due: true,
      checked: true,
      cache: 'hit',
      window: true,
    });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
  });

  it('在窗口内但数据库说不到点 → 顺手把窗口收紧', async () => {
    cacheMock.store.set(STATE_KEY, state({ windows: [{ start: 540, end: 1080 }] }));
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });

    await expect(probeDue(NOW)).resolves.toEqual({
      due: false,
      checked: true,
      cache: 'hit',
      window: true,
    });
    expect(cacheMock.set).toHaveBeenCalledTimes(1);
    const [, value] = cacheMock.set.mock.calls[0]!;
    expect((value as DueState).windows).toEqual([]);
  });
});

describe('probeDue — 缓存未命中', () => {
  it('重建一次并写回缓存', async () => {
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: true, windows: [{ start: 600, end: 1440 }] });

    await expect(probeDue(NOW)).resolves.toEqual({
      due: true,
      checked: true,
      cache: 'miss',
      window: true,
    });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
    expect(cacheMock.set).toHaveBeenCalledTimes(1);
    const [key, value, options] = cacheMock.set.mock.calls[0]!;
    expect(key).toBe(STATE_KEY);
    expect(value).toMatchObject({
      version: 1,
      date: '2026-11-01',
      windows: [{ start: 600, end: 1440 }],
    });
    expect(options).toMatchObject({ tags: [DUE_STATE_TAG], ttl: 26 * 60 * 60 });
  });

  it('超过 2 小时视为未命中并重建', async () => {
    const stale = state({
      generatedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      windows: [{ start: 0, end: 1440 }],
    });
    cacheMock.store.set(STATE_KEY, stale);
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });

    await expect(probeDue(NOW)).resolves.toMatchObject({ cache: 'miss' });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
  });

  it('日期不是今天视为未命中', async () => {
    cacheMock.store.set(STATE_KEY, state({ date: '2026-10-31', windows: [{ start: 0, end: 1440 }] }));
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });

    await expect(probeDue(NOW)).resolves.toMatchObject({ cache: 'miss' });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
  });

  it('版本不符视为未命中', async () => {
    cacheMock.store.set(STATE_KEY, { ...state(), version: 0 });
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });

    await expect(probeDue(NOW)).resolves.toMatchObject({ cache: 'miss' });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
  });

  it('generatedAt 明显在未来视为未命中（时钟漂移防御）', async () => {
    cacheMock.store.set(
      STATE_KEY,
      state({
        generatedAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
        windows: [{ start: 0, end: 1440 }],
      }),
    );
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });

    await expect(probeDue(NOW)).resolves.toMatchObject({ cache: 'miss' });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('probeDue — 失效 epoch', () => {
  it('状态早于最近一次失效 → 视为未命中并重建', async () => {
    cacheMock.store.set(STATE_KEY, state({ generatedAt: NOW.toISOString() }));
    cacheMock.store.set(DUE_STATE_EPOCH_KEY, NOW.getTime() + 1000);
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [] });

    await expect(probeDue(NOW)).resolves.toMatchObject({ cache: 'miss' });
    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
  });

  it('状态晚于最近一次失效 → 正常命中', async () => {
    cacheMock.store.set(
      STATE_KEY,
      state({
        generatedAt: new Date(NOW.getTime() + 1000).toISOString(),
        windows: [{ start: 540, end: 600 }],
      }),
    );
    cacheMock.store.set(DUE_STATE_EPOCH_KEY, NOW.getTime());

    await expect(probeDue(NOW)).resolves.toEqual({
      due: false,
      checked: false,
      cache: 'hit',
      window: false,
    });
    expect(dueMock.readDueSnapshot).not.toHaveBeenCalled();
  });
});

describe('probeDue — 缓存异常', () => {
  it('读取抛错 → 回落 anyDigestDue', async () => {
    cacheMock.throwOnGet = true;
    dueMock.anyDigestDue.mockResolvedValue(true);

    await expect(probeDue(NOW)).resolves.toEqual({
      due: true,
      checked: true,
      cache: 'off',
      window: false,
    });
    expect(dueMock.anyDigestDue).toHaveBeenCalledTimes(1);
  });

  it('写回抛错不影响本次判定', async () => {
    cacheMock.throwOnSet = true;
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: true, windows: [{ start: 600, end: 1440 }] });

    await expect(probeDue(NOW)).resolves.toMatchObject({
      due: true,
      cache: 'miss',
    });
  });

  it('窗口内重查抛错 → 回落 anyDigestDue', async () => {
    cacheMock.store.set(STATE_KEY, state());
    dueMock.readDueSnapshot.mockRejectedValue(new Error('db down'));
    dueMock.anyDigestDue.mockResolvedValue(true);

    await expect(probeDue(NOW)).resolves.toEqual({
      due: true,
      checked: true,
      cache: 'hit',
      window: true,
    });
    expect(dueMock.anyDigestDue).toHaveBeenCalledTimes(1);
  });

  it('未命中重建抛错 → 回落 anyDigestDue', async () => {
    dueMock.readDueSnapshot.mockRejectedValue(new Error('db down'));
    dueMock.anyDigestDue.mockResolvedValue(true);

    await expect(probeDue(NOW)).resolves.toEqual({
      due: true,
      checked: true,
      cache: 'miss',
      window: false,
    });
    expect(dueMock.anyDigestDue).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateDueState / refreshDueState', () => {
  it('失效写 epoch 并按 tag 过期，不查库', async () => {
    await invalidateDueState();
    expect(cacheMock.set).toHaveBeenCalledWith(
      DUE_STATE_EPOCH_KEY,
      expect.any(Number),
      expect.objectContaining({ ttl: 26 * 60 * 60 }),
    );
    expect(cacheMock.expireTag).toHaveBeenCalledWith(DUE_STATE_TAG);
    expect(dueMock.readDueSnapshot).not.toHaveBeenCalled();
  });

  it('epoch 写失败仍会 expireTag', async () => {
    cacheMock.throwOnSet = true;
    await invalidateDueState();
    expect(cacheMock.expireTag).toHaveBeenCalledWith(DUE_STATE_TAG);
  });

  it('失效失败静默吞掉', async () => {
    cacheMock.throwOnExpire = true;
    await expect(invalidateDueState()).resolves.toBeUndefined();
  });

  it('发送后刷新：重建并覆盖缓存', async () => {
    dueMock.readDueSnapshot.mockResolvedValue({ dueNow: false, windows: [{ start: 540, end: 1080 }] });

    await refreshDueState(NOW);

    expect(dueMock.readDueSnapshot).toHaveBeenCalledTimes(1);
    expect(cacheMock.set).toHaveBeenCalledTimes(1);
  });
});
