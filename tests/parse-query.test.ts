import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fallbackParse,
  parseSearchQuery,
  SearchQuerySchema,
  type SearchQuery,
} from '../src/agent/parse-query';

/**
 * 只 mock llm 模块（同 llm.test.ts 的 vi.hoisted 惯例），parse-query 走
 * generateObjectSafe 的替身，绝无真实 API 调用。
 */
const mocks = vi.hoisted(() => ({
  generateObjectSafe: vi.fn(),
}));

vi.mock('../src/agent/llm', () => ({ generateObjectSafe: mocks.generateObjectSafe }));

const DEFAULTS: SearchQuery = {
  languages: [],
  keywords: [],
  period: 'week',
  minStars: null,
  sortBy: 'stars_delta',
  topN: 10,
};

function llmQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { ...DEFAULTS, ...overrides };
}

beforeEach(() => {
  mocks.generateObjectSafe.mockReset();
});

describe('SearchQuerySchema', () => {
  it('accepts the default query shape', () => {
    expect(SearchQuerySchema.parse(DEFAULTS)).toEqual(DEFAULTS);
  });

  it('rejects an invalid period or sortBy', () => {
    expect(() => SearchQuerySchema.parse({ ...DEFAULTS, period: 'daily' })).toThrow();
    expect(() => SearchQuerySchema.parse({ ...DEFAULTS, sortBy: 'forks' })).toThrow();
  });
});

describe('parseSearchQuery — LLM path', () => {
  it('returns the LLM result when generateObjectSafe resolves a valid object', async () => {
    const llmResult = llmQuery({
      languages: ['go'],
      keywords: ['agent'],
      period: 'today',
      minStars: 5000,
      sortBy: 'new',
      topN: 5,
    });
    mocks.generateObjectSafe.mockResolvedValue(llmResult);

    const result = await parseSearchQuery('今天 go 里 agent 相关的');

    expect(result).toEqual(llmResult);
    expect(mocks.generateObjectSafe).toHaveBeenCalledTimes(1);
    expect(mocks.generateObjectSafe).toHaveBeenCalledWith(
      SearchQuerySchema,
      expect.stringContaining('今天 go 里 agent 相关的'),
    );
  });

  it('normalizes LLM output: lowercases languages, trims keywords, clamps topN and minStars', async () => {
    mocks.generateObjectSafe.mockResolvedValue(
      llmQuery({ languages: [' Python ', 'RUST'], keywords: ['  AI  '], minStars: -5, topN: 99 }),
    );

    const result = await parseSearchQuery('x');

    expect(result.languages).toEqual(['python', 'rust']);
    expect(result.keywords).toEqual(['AI']);
    expect(result.minStars).toBe(0);
    expect(result.topN).toBe(25);
  });

  it('clamps topN to at least 1', async () => {
    mocks.generateObjectSafe.mockResolvedValue(llmQuery({ topN: 0 }));

    await expect(parseSearchQuery('x')).resolves.toMatchObject({ topN: 1 });
  });

  it('builds a prompt with >= 3 few-shot examples and a never-invent instruction', async () => {
    mocks.generateObjectSafe.mockResolvedValue(null);

    await parseSearchQuery('本周 python 里 ai 相关的');

    const prompt = mocks.generateObjectSafe.mock.calls[0]?.[1] as string;
    const exampleCount = (prompt.match(/示例\s*\d+/g) ?? []).length;
    expect(exampleCount).toBeGreaterThanOrEqual(3);
    expect(prompt).toContain('只允许从');
    expect(prompt).toContain('禁止编造');
    expect(prompt).toContain('本周 python 里 ai 相关的');
  });
});

describe('parseSearchQuery — regex fallback when LLM returns null', () => {
  beforeEach(() => {
    mocks.generateObjectSafe.mockResolvedValue(null);
  });

  it('"本周 python 里 ai 相关的" → python / ai / week', async () => {
    await expect(parseSearchQuery('本周 python 里 ai 相关的')).resolves.toEqual({
      languages: ['python'],
      keywords: ['ai'],
      period: 'week',
      minStars: null,
      sortBy: 'stars_delta',
      topN: 10,
    });
  });

  it('"帮我看下最近 star 增长快的 rust 项目" → rust / week / stars_delta', async () => {
    await expect(parseSearchQuery('帮我看下最近 star 增长快的 rust 项目')).resolves.toEqual({
      languages: ['rust'],
      keywords: [],
      period: 'week',
      minStars: null,
      sortBy: 'stars_delta',
      topN: 10,
    });
  });

  it('no-signal text "啊" → all defaults', async () => {
    await expect(parseSearchQuery('啊')).resolves.toEqual(DEFAULTS);
  });

  it('still calls generateObjectSafe with the schema before falling back', async () => {
    await parseSearchQuery('啊');

    expect(mocks.generateObjectSafe).toHaveBeenCalledTimes(1);
    expect(mocks.generateObjectSafe).toHaveBeenCalledWith(SearchQuerySchema, expect.any(String));
  });
});

describe('fallbackParse (direct, pure)', () => {
  it('extracts multiple languages and maps 新 → new', () => {
    expect(fallbackParse('python 和 rust 的新项目')).toEqual({
      languages: ['python', 'rust'],
      keywords: [],
      period: 'week',
      minStars: null,
      sortBy: 'new',
      topN: 10,
    });
  });

  it('extracts period today, minStars and topN', () => {
    expect(fallbackParse('今天 go 项目 5000 star 以上，前 5')).toEqual({
      languages: ['go'],
      keywords: [],
      period: 'today',
      minStars: 5000,
      sortBy: 'stars_delta',
      topN: 5,
    });
  });

  it('maps 本月 → month and 最新 → new', () => {
    expect(fallbackParse('本月 typescript 最新项目')).toMatchObject({
      period: 'month',
      sortBy: 'new',
      languages: ['typescript'],
    });
  });

  it('maps star 最多 → stars', () => {
    expect(fallbackParse('本周 rust star 最多的项目').sortBy).toBe('stars');
  });

  it('scales k / 万 suffixes for minStars', () => {
    expect(fallbackParse('10k star 以上的项目').minStars).toBe(10000);
    expect(fallbackParse('star 超过 1万 的项目').minStars).toBe(10000);
  });

  it('does not call the LLM (pure function)', () => {
    fallbackParse('本周 python 里 ai 相关的');

    expect(mocks.generateObjectSafe).not.toHaveBeenCalled();
  });
});
