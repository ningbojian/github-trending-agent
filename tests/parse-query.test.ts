import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fallbackParse,
  INTERACTIVE_TIMEOUT_MS,
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
  intent: 'search',
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
      undefined,
      { timeoutMs: INTERACTIVE_TIMEOUT_MS },
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

  it('cleans keywords: strips punctuation (。！？!?；;，,、()（）) and drops empty after cleaning', async () => {
    mocks.generateObjectSafe.mockResolvedValue(
      llmQuery({ keywords: [' AI！', '（框架）', '。', ''] }),
    );

    const result = await parseSearchQuery('x');

    expect(result.keywords).toEqual(['AI', '框架']);
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

  it('prompt 含「找一下本周比较火的Java项目」示例，并注明热度词不得作为 keywords', async () => {
    mocks.generateObjectSafe.mockResolvedValue(null);

    await parseSearchQuery('x');

    const prompt = mocks.generateObjectSafe.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('找一下本周比较火的Java项目');
    expect(prompt).toContain(
      '{"intent":"search","languages":["java"],"keywords":[],"period":"week","minStars":null,"sortBy":"stars_delta","topN":10}',
    );
    expect(prompt).toMatch(/比较火.*热门.*流行/);
    expect(prompt).toContain('不得作为 keywords');
  });
});

describe('parseSearchQuery — LlmChoice（谁的 Key）', () => {
  it('kind: none → 完全不调模型，直接走规则解析', async () => {
    const result = await parseSearchQuery('本周 python 的 ai 项目', { kind: 'none' });

    expect(result).toEqual(fallbackParse('本周 python 的 ai 项目'));
    expect(mocks.generateObjectSafe).not.toHaveBeenCalled();
  });

  it('kind: user → 把用户配置作为第三参传下去', async () => {
    const config = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x-123456789' };
    mocks.generateObjectSafe.mockResolvedValue(null);

    await parseSearchQuery('rust 项目', { kind: 'user', config });

    expect(mocks.generateObjectSafe).toHaveBeenCalledWith(
      SearchQuerySchema,
      expect.any(String),
      config,
      { timeoutMs: INTERACTIVE_TIMEOUT_MS },
    );
  });

  it('默认（不传）→ 仍走运营方 Key，第三参为空（老路径行为不变）', async () => {
    mocks.generateObjectSafe.mockResolvedValue(null);

    await parseSearchQuery('rust 项目');

    expect(mocks.generateObjectSafe.mock.calls[0][0]).toBe(SearchQuerySchema);
    expect(mocks.generateObjectSafe.mock.calls[0][2]).toBeUndefined();
  });

  it('互动路径只给 8 秒：超时不如直接回退正则', async () => {
    mocks.generateObjectSafe.mockResolvedValue(null);

    await parseSearchQuery('rust 项目');

    expect(INTERACTIVE_TIMEOUT_MS).toBe(8_000);
    expect(mocks.generateObjectSafe.mock.calls[0][3]).toEqual({
      timeoutMs: 8_000,
    });
  });
});

describe('parseSearchQuery — regex fallback when LLM returns null', () => {
  beforeEach(() => {
    mocks.generateObjectSafe.mockResolvedValue(null);
  });

  it('"本周 python 里 ai 相关的" → python / ai / week', async () => {
    await expect(parseSearchQuery('本周 python 里 ai 相关的')).resolves.toEqual({
      intent: 'search',
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
      intent: 'search',
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
    expect(mocks.generateObjectSafe).toHaveBeenCalledWith(
      SearchQuerySchema,
      expect.any(String),
      undefined,
      { timeoutMs: INTERACTIVE_TIMEOUT_MS },
    );
  });
});

describe('fallbackParse (direct, pure)', () => {
  it('extracts multiple languages and maps 新 → new', () => {
    expect(fallbackParse('python 和 rust 的新项目')).toEqual({
      intent: 'search',
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
      intent: 'search',
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

  it('"找一下本周比较火的Java项目" → java / keywords=[] / week（热度语与请求语全部剔除）', () => {
    expect(fallbackParse('找一下本周比较火的Java项目')).toEqual({
      intent: 'search',
      languages: ['java'],
      keywords: [],
      period: 'week',
      minStars: null,
      sortBy: 'stars_delta',
      topN: 10,
    });
  });

  it('新增多字填充词（一下/比较/热门/流行/一些/推荐/麻烦/想要/给我/最近几天）不入 keywords', () => {
    expect(
      fallbackParse('麻烦给我推荐一些最近几天比较火的rust项目').keywords,
    ).toEqual([]);
    expect(fallbackParse('想要热门流行的go项目').keywords).toEqual([]);
  });

  it('"麻烦给我推荐一些go项目" → keywords=[]（纯请求虚词串整 token 丢弃）', () => {
    expect(fallbackParse('麻烦给我推荐一些go项目')).toMatchObject({
      languages: ['go'],
      keywords: [],
    });
  });

  // ---------------------------------------------------------------------------
  // 复合词保护：填充词只做 token 级判定（完整覆盖→丢弃、尾剥、前导剥），
  // 绝不做全局子串 replace——否则「比较器」被剥成空、「推荐系统」漏出「系统」。
  // ---------------------------------------------------------------------------
  it('「本周 rust 比较器」→ keywords 含「比较器」（不被「比较」剥空）', () => {
    expect(fallbackParse('本周 rust 比较器')).toMatchObject({
      languages: ['rust'],
      keywords: ['比较器'],
    });
  });

  it('「找一下推荐系统的python项目」→ keywords 含「推荐系统」（不漏出过宽的「系统」）', () => {
    expect(fallbackParse('找一下推荐系统的python项目')).toMatchObject({
      languages: ['python'],
      keywords: ['推荐系统'],
    });
  });

  it('「流行病学项目」→ keywords 含「流行病学」（「流行」不作中间插入式剔除）', () => {
    expect(fallbackParse('流行病学项目').keywords).toEqual(['流行病学']);
  });

  it('「热门游戏 rust」→ keywords 含「热门游戏」（前导剥除后剩 2 字则整词保留）', () => {
    expect(fallbackParse('热门游戏 rust')).toMatchObject({
      languages: ['rust'],
      keywords: ['热门游戏'],
    });
  });

  it('尾部剥离规则：「好看的项目」→「好看」（每次剥完剩余 ≥2 才剥）', () => {
    expect(fallbackParse('好看的项目').keywords).toContain('好看');
  });

  it('前导剥离规则：「帮我看看人工智能项目」→「人工智能」（剥完剩余 ≥3 才剥）', () => {
    expect(fallbackParse('帮我看看人工智能项目').keywords).toContain('人工智能');
  });

  it('不加裸单字填充词且填充只做 token 级判定：复合词绝不中间挖空', () => {
    // 「火狐」若被单字「火」剔除会剩「狐」，再被 length<2 丢弃——裸单字填充词的直接危害
    expect(fallbackParse('火狐项目').keywords).toEqual(['火狐']);
    // 前导「看看」剥除后剩「火狐」(2 < 3) 不剥，整词保留（无中间插入式剔除）
    expect(fallbackParse('看看火狐项目').keywords).toEqual(['看看火狐']);
  });

  it('新增语言别名 html / css / vue 可识别且不入 keywords', () => {
    expect(fallbackParse('本周 html css vue 项目')).toEqual({
      intent: 'search',
      languages: ['html', 'css', 'vue'],
      keywords: [],
      period: 'week',
      minStars: null,
      sortBy: 'stars_delta',
      topN: 10,
    });
  });

  it('c 别名不吞 css/c++（长别名先匹配的边界保持）', () => {
    expect(fallbackParse('css 和 c++ 项目').languages).toEqual(['c++', 'css']);
  });

  it('does not call the LLM (pure function)', () => {
    fallbackParse('本周 python 里 ai 相关的');

    expect(mocks.generateObjectSafe).not.toHaveBeenCalled();
  });
});
