import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 推送准点依赖 Vercel Cron：GitHub Actions 的 schedule 实测会整段丢触发
 * （2026-10-28 出现过 09:17–13:17 连续五个 tick 不跑，用户 14:03 才收到简报）。
 *
 * 这条测试锁定 `vercel.json` 的调度本身——它没有类型检查、没有运行时校验，
 * 被误删或改了时区都不会报错，只会安静地晚几个小时推送。
 * `0 1 * * *` 是 UTC，= 北京时间 09:00。
 */
describe('Vercel Cron', () => {
  it('每天 01:00 UTC（北京 09:00）触发一次简报推送', () => {
    const config = JSON.parse(
      readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
    ) as { crons?: Array<{ path: string; schedule: string }> };

    expect(config.crons).toEqual([
      { path: '/api/cron-push-digest', schedule: '0 1 * * *' },
    ]);
  });
});
