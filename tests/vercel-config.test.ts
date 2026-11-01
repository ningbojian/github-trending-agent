import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 推送准点依赖 Vercel Cron：GitHub Actions 的 schedule 实测会整段丢触发
 * （2026-10-28 出现过 09:17–13:17 连续五个 tick 不跑，用户 14:03 才收到简报）。
 *
 * 这条测试锁定 `vercel.json` 的调度本身——它没有类型检查、没有运行时校验，
 * 被误删或改了时区都不会报错，只会安静地晚几个小时推送。
 * `0 1 * * *` 是 UTC，= 北京时间 09:00。
 */
describe('Vercel 配置', () => {
  it('每天 01:00 UTC（北京 09:00）触发一次简报推送', () => {
    const config = JSON.parse(
      readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
    ) as { crons?: Array<{ path: string; schedule: string }> };

    // 两个每天一次的 cron：北京 09:00 与 10:00。
    // GitHub Actions 的定时触发实测会整段漏跑；这两个时刻不依赖 Actions，
    // 覆盖默认 09:00 与常见的 10:00 设置。其它时间靠 GitHub/自愈兜底。
    expect(config.crons).toEqual([
      { path: '/api/cron-push-digest', schedule: '0 1 * * *' },
      { path: '/api/cron-push-digest', schedule: '0 2 * * *' },
    ]);
  });

  it('Serverless Function 不超过 12 个——Hobby 套餐的硬上限', () => {
    // 超过 12 个的部署会整体失败（2026-10-28 加第 13 个函数时连挂三次，
    // 错误在 Vercel 日志里，GitHub 状态只显示 Deployment has failed）。
    const files = readdirSync(new URL('../api', import.meta.url)).filter((name) =>
      name.endsWith('.ts'),
    );
    expect(files.length).toBeLessThanOrEqual(12);
  });
});
