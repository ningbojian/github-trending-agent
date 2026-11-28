import { describe, expect, it } from 'vitest';
import { cleanup, type SqlExecutor } from '../scripts/cleanup.js';

function fakeSql(responses: unknown[][]): {
  sql: SqlExecutor;
  calls: Array<{ text: string; params: unknown[] }>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let i = 0;
  const sql: SqlExecutor = async (strings, ...values) => {
    calls.push({ text: strings.join(''), params: values });
    return responses[i++] ?? [];
  };
  return { sql, calls };
}

describe('cleanup', () => {
  const now = new Date('2026-11-28T00:00:00.000Z');

  it('deletes rows older than 30 days from both tables', async () => {
    const { sql, calls } = fakeSql([[{}, {}, {}], [{}]]);
    const result = await cleanup(sql, now);

    expect(result).toEqual({ agentRuns: 3, toolCalls: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain('agent_runs');
    expect(calls[1]!.text).toContain('tool_calls');
  });

  it('uses a cutoff exactly 30 days before now', async () => {
    const { sql, calls } = fakeSql([[], []]);
    await cleanup(sql, now);

    const expected = new Date('2026-10-29T00:00:00.000Z').toISOString();
    expect(calls[0]!.params).toEqual([expected]);
    expect(calls[1]!.params).toEqual([expected]);
  });

  it('handles empty result sets without error', async () => {
    const { sql } = fakeSql([[], []]);
    expect(await cleanup(sql, now)).toEqual({ agentRuns: 0, toolCalls: 0 });
  });
});
