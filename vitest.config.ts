import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 默认 5s：本机 31 个 worker 并发、同时还有别的重任务时，纯内存用例也会被 CPU 抢占打爆
    // （实测 trending 抓取用例偶发超时，单独重跑与随后整轮均全绿）。放宽到 15s 只影响极端争抢，
    // 真卡死仍然会失败，不会掩盖死锁。
    testTimeout: 15_000,
  },
});
