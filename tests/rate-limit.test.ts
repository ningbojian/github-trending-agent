import { describe, expect, it } from 'vitest';
import {
  DAILY_MESSAGE_LIMIT,
  PER_MINUTE_MESSAGE_LIMIT,
  RATE_LIMIT_REPLY,
  checkQuota,
  minuteBucket,
  shanghaiDayKey,
  type QuotaStore,
} from '../src/agent/rate-limit';

/**
 * 按用户限流。
 *
 * 这个模块存在的理由：全仓此前**没有任何**按用户的速率限制（只有 GitHub API
 * 的 retry-after 退避）。用户配了自己的 Key 后，一个循环发消息的脚本能无限
 * 烧额度。这是安全性缺口，不是功能缺失，所以判定必须精确、必须能测。
 *
 * 关键约束：**绝不能读-改-写**。现有的 `takeConfirmSlot` / `bumpDailySent`
 * 都是 select→加一→upsert，并发下会超发。这里用存储层的原子累加。
 */

/** 内存版存储：模拟「同一个桶只有一次原子累加」。 */
class FakeStore implements QuotaStore {
  readonly counts = new Map<string, number>();

  async increment(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

const NOW = new Date('2026-10-28T02:00:30Z'); // 北京 10-28 10:00:30

describe('时间桶', () => {
  it('分钟桶按北京时间的分钟对齐', () => {
    expect(minuteBucket(new Date('2026-10-28T02:00:00Z'))).toBe('202610281000');
    expect(minuteBucket(new Date('2026-10-28T02:00:59Z'))).toBe('202610281000');
    expect(minuteBucket(new Date('2026-10-28T02:01:00Z'))).toBe('202610281001');
  });

  it('日键按北京日期，不是 UTC 日期', () => {
    // UTC 16:00 = 北京次日 00:00 —— 用 UTC 会算错一天
    expect(shanghaiDayKey(new Date('2026-10-28T15:59:00Z'))).toBe('20261028');
    expect(shanghaiDayKey(new Date('2026-10-28T16:00:00Z'))).toBe('20261029');
  });
});

describe('checkQuota', () => {
  it('前 N 次放行，第 N+1 次拒绝', async () => {
    const store = new FakeStore();

    for (let i = 1; i <= PER_MINUTE_MESSAGE_LIMIT; i += 1) {
      const result = await checkQuota('alice', NOW, store);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeNull();
    }

    const blocked = await checkQuota('alice', NOW, store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('minute');
  });

  it('拒绝时给出还能等多久（秒）', async () => {
    const store = new FakeStore();
    for (let i = 0; i < PER_MINUTE_MESSAGE_LIMIT; i += 1) {
      await checkQuota('alice', NOW, store);
    }

    const blocked = await checkQuota('alice', NOW, store);
    expect(blocked.allowed).toBe(false);
    // 北京 10:00:30 → 本分钟还剩 30 秒
    expect(blocked.retryAfterSeconds).toBe(30);
  });

  it('不同用户互不影响', async () => {
    const store = new FakeStore();
    for (let i = 0; i < PER_MINUTE_MESSAGE_LIMIT; i += 1) {
      await checkQuota('alice', NOW, store);
    }

    expect((await checkQuota('alice', NOW, store)).allowed).toBe(false);
    expect((await checkQuota('bob', NOW, store)).allowed).toBe(true);
  });

  it('跨分钟桶自动恢复', async () => {
    const store = new FakeStore();
    for (let i = 0; i < PER_MINUTE_MESSAGE_LIMIT; i += 1) {
      await checkQuota('alice', NOW, store);
    }
    expect((await checkQuota('alice', NOW, store)).allowed).toBe(false);

    const nextMinute = new Date(NOW.getTime() + 60_000);
    expect((await checkQuota('alice', nextMinute, store)).allowed).toBe(true);
  });

  it('日上限触发时原因为 day 并提示等明天', async () => {
    const store = new FakeStore();
    // 直接灌满日计数，分钟计数留空
    store.counts.set(`rl:v1:day:alice:${shanghaiDayKey(NOW)}`, DAILY_MESSAGE_LIMIT);

    const blocked = await checkQuota('alice', NOW, store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('day');
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('被分钟桶拒绝时不消耗日计数', async () => {
    const store = new FakeStore();
    for (let i = 0; i < PER_MINUTE_MESSAGE_LIMIT; i += 1) {
      const result = await checkQuota('alice', NOW, store);
      expect(result.allowed).toBe(true);
    }
    const dayKey = `rl:v1:day:alice:${shanghaiDayKey(NOW)}`;
    const dayCountBefore = store.counts.get(dayKey);
    expect(dayCountBefore).toBe(PER_MINUTE_MESSAGE_LIMIT);

    // 再打 5 次，全部被分钟桶拒绝：日计数一次都不该动。
    for (let i = 0; i < 5; i += 1) {
      const blocked = await checkQuota('alice', NOW, store);
      expect(blocked.reason).toBe('minute');
    }

    expect(store.counts.get(dayKey)).toBe(dayCountBefore);
  });

  it('存储抛错时放行（fail-open）', async () => {
    // 限流是保护措施，不是业务前提。存储挂了就让消息过去——
    // 否则一次缓存故障会变成全员不能说话。
    const broken: QuotaStore = {
      async increment() {
        throw new Error('kv down');
      },
    };
    const result = await checkQuota('alice', NOW, broken);
    expect(result.allowed).toBe(true);
  });
});

describe('RATE_LIMIT_REPLY', () => {
  it('是纯文本单行、不含 markdown 链接语法（个人微信不渲染）', () => {
    expect(RATE_LIMIT_REPLY).not.toContain('](');
    expect(RATE_LIMIT_REPLY).not.toContain('\n');
    expect(RATE_LIMIT_REPLY.length).toBeLessThan(120);
  });
});
