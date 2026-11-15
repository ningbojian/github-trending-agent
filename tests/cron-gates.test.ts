import { describe, expect, it } from 'vitest';
import { cronGates } from '../src/agent/cron-gates';

/** 2026-11-09 是周一；北京时间 = UTC+8。 */
function bj(day: string, hh: number, mm: number): Date {
  return new Date(
    `${day}T${String(hh - 8).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`,
  );
}

describe('cronGates — 30 分钟 tick 下的任务围栏', () => {
  it('周一 09:03：跑 tracking，不跑 weekly，heartbeat 在整点 tick 写', () => {
    const gates = cronGates(bj('2026-11-09', 9, 3), false);
    expect(gates).toEqual({ tracking: true, weekly: false, heartbeat: true });
  });

  it('周一 09:33：tracking 仍然可跑，但 heartbeat 不写', () => {
    const gates = cronGates(bj('2026-11-09', 9, 33), false);
    expect(gates.tracking).toBe(true);
    expect(gates.heartbeat).toBe(false);
  });

  it('周一 10:03：weekly 窗口打开，tracking 窗口关闭', () => {
    const gates = cronGates(bj('2026-11-09', 10, 3), false);
    expect(gates.weekly).toBe(true);
    expect(gates.tracking).toBe(false);
  });

  it('周一 12:03：weekly 窗口关闭', () => {
    expect(cronGates(bj('2026-11-09', 12, 3), false).weekly).toBe(false);
  });

  it('周二 10:03：weekly 不跑', () => {
    expect(cronGates(bj('2026-11-10', 10, 3), false).weekly).toBe(false);
  });

  it('09:33 有真实到点任务时，heartbeat 仍然写', () => {
    const gates = cronGates(bj('2026-11-09', 9, 33), true);
    expect(gates.heartbeat).toBe(true);
  });
});
