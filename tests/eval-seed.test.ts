import { describe, expect, it } from 'vitest';
import { groupCandidates, type IntentLogRow } from '../evals/seed-from-intent-log';

function row(day: string, text: string, final: string): IntentLogRow {
  return { key: `intent-miss:${day}:${'a'.repeat(40)}`, value: { text, final } };
}

describe('eval seed — 匿名意图日志聚合', () => {
  it('同一句话跨天合并计数，保留最近一次结论', () => {
    const candidates = groupCandidates([
      row('20261020', '今天天气如何', 'off_topic'),
      row('20261022', '今天天气如何', 'about'),
    ]);
    expect(candidates).toEqual([
      { text: '今天天气如何', final: 'about', count: 2, lastDay: '2026-10-22' },
    ]);
  });

  it('按出现次数降序，同频按文本排序（输出稳定可 diff）', () => {
    const candidates = groupCandidates([
      row('20261020', 'alpha', 'search'),
      row('20261020', 'beta', 'search'),
      row('20261021', 'beta', 'search'),
    ]);
    expect(candidates.map((c) => c.text)).toEqual(['beta', 'alpha']);
  });

  it('忽略坏 key / 坏 value，不因脏数据中断', () => {
    const candidates = groupCandidates([
      { key: 'parse:v1:xxx', value: { text: '不该出现', final: 'search' } },
      { key: 'intent-miss:bad-day:abc', value: { text: 'x', final: 'search' } },
      { key: 'intent-miss:20261020:abc', value: { text: '', final: 'search' } },
      { key: 'intent-miss:20261020:def', value: { text: '正常', final: 'nope' } },
      { key: 'intent-miss:20261020:ghi', value: null },
      row('20261020', '有效', 'search'),
    ]);
    expect(candidates.map((c) => c.text)).toEqual(['有效']);
  });

  it('输出不含任何用户标识（日志本身也不存）', () => {
    const serialized = JSON.stringify(
      groupCandidates([row('20261020', '本周 python', 'search')]),
    );
    expect(serialized).not.toMatch(/wecomUserid|userid|fromUserName/i);
  });
});
