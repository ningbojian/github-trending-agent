import { describe, expect, it } from 'vitest';
import { normalizePreferences } from '../src/agent/preferences';

describe('normalizePreferences — weeklyOpportunities', () => {
  it('默认开启', () => {
    expect(normalizePreferences({}).weeklyOpportunities).toBe(true);
  });

  it('显式 false 关闭', () => {
    expect(
      normalizePreferences({ weeklyOpportunities: false }).weeklyOpportunities,
    ).toBe(false);
  });
});
