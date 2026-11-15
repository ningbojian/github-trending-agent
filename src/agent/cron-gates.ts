import { shanghaiMinutes, shanghaiToday } from './time.js';

/**
 * 30 分钟 tick 下的任务围栏（北京时间）。
 *
 * 现状：GitHub Actions 每 30 分钟触发一次 cron，Neon 每被查询一次就唤醒
 * compute 并保持 scale-to-zero 窗口。把 tracking / weekly / heartbeat 从
 * 「每个 tick 都跑」改成按窗口跑，减少无意义的查询和写入。
 *
 * - tracking：09:00–10:00 的两次 tick（函数内部还有 20 小时判断，不会重复处理）
 * - weekly：周一 10:00–12:00 的四次 tick（函数自身也按周一 10 点后幂等）
 * - heartbeat：有真实到点任务，或整点后的第一个 tick（:03）写一次
 */
export interface CronGates {
  tracking: boolean;
  weekly: boolean;
  heartbeat: boolean;
}

export function cronGates(now: Date, due: boolean): CronGates {
  const minutes = shanghaiMinutes(now);
  // 2026-11-09 / 2026-11-16 等周一；shanghaiToday 返回北京时间日期。
  const weekday = new Date(`${shanghaiToday(now)}T00:00:00.000Z`).getUTCDay();

  return {
    tracking: minutes >= 9 * 60 && minutes < 10 * 60,
    weekly: weekday === 1 && minutes >= 10 * 60 && minutes < 12 * 60,
    heartbeat: due || minutes % 60 < 30,
  };
}
