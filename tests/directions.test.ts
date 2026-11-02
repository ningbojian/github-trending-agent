import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  directionByAlias,
  filterByDirections,
  matchesDirection,
  splitDirectionTokens,
} from '../src/agent/directions';

describe('directions', () => {
  it('别名大小写不敏感，认不出返回 null', () => {
    expect(directionByAlias('AI')?.key).toBe('agent');
    expect(directionByAlias('大模型')?.key).toBe('agent');
    expect(directionByAlias('前端')?.key).toBe('frontend');
    expect(directionByAlias('数据库')?.key).toBe('database');
    expect(directionByAlias('量子计算')).toBeNull();
  });

  it('订阅词拆分：认得出的进方向，认不出的留关键词', () => {
    expect(splitDirectionTokens(['AI', '前端', 'python'])).toEqual({
      topics: ['agent', 'frontend'],
      keywords: ['python'],
    });
    expect(splitDirectionTokens(['mcp'])).toEqual({
      topics: [],
      keywords: ['mcp'],
    });
  });

  it('方向 key / 别名不重复', () => {
    const keys = DIRECTIONS.map((direction) => direction.key);
    expect(new Set(keys).size).toBe(keys.length);
    const aliases = DIRECTIONS.flatMap((direction) => direction.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

describe('matchesDirection', () => {
  const item = {
    fullName: 'acme/agent-kit',
    description: 'An LLM agent framework',
    topics: ['llm', 'mcp'],
  };

  it('命中名字/描述/topics 任一字段', () => {
    expect(matchesDirection(item, 'agent')).toBe(true);
    expect(matchesDirection(item, 'media')).toBe(false);
  });

  it('ASCII 关键词按词边界匹配，不误伤子串', () => {
    expect(
      matchesDirection({ fullName: 'a/b', description: 'said something' }, 'agent'),
    ).toBe(false);
  });

  it('未知方向 → false', () => {
    expect(matchesDirection(item, 'nope')).toBe(false);
  });
});

describe('filterByDirections', () => {
  const items = [
    { fullName: 'a/agent', topics: ['llm'], description: null },
    { fullName: 'b/vision', topics: ['vision'], description: null },
  ];

  it('按方向过滤', () => {
    expect(filterByDirections(items, ['agent']).map((item) => item.fullName)).toEqual([
      'a/agent',
    ]);
  });

  it('全都没命中时退回原列表（不发空简报）', () => {
    expect(filterByDirections(items, ['quant'])).toHaveLength(2);
  });

  it('没有方向时原样返回', () => {
    expect(filterByDirections(items, [])).toHaveLength(2);
  });
});
