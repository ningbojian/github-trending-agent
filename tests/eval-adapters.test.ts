import { describe, expect, it } from 'vitest';
import { extractRepoRefs, observeAnswer } from '../evals/adapters/answer';
import { observeParse } from '../evals/adapters/parse';
import { observeRoute } from '../evals/adapters/route';
import { observeToolRoute } from '../evals/adapters/tools';

describe('eval adapters — 路由', () => {
  it('精确指令走对应 handler', () => {
    expect(observeRoute('帮助')).toMatchObject({ kind: 'handler', name: 'help' });
    expect(observeRoute('收藏 3')).toMatchObject({ kind: 'handler', name: 'favorite' });
  });

  it('疑似命令回用法提示', () => {
    expect(observeRoute('收藏一下')).toMatchObject({ kind: 'usage', name: 'favorite' });
  });

  it('自然语言落搜索', () => {
    expect(observeRoute('本周 python 的 ai 项目')).toMatchObject({
      kind: 'handler',
      name: 'search',
    });
  });
});

describe('eval adapters — 解析（零模型、零缓存）', () => {
  it('规则拿不准时用 fallbackParse 的槽位', async () => {
    const observation = await observeParse('本周 python 的 ai 项目');
    expect(observation.ruleIntent).toBeNull();
    expect(observation.intent).toBe('search');
    expect(observation.query.languages).toEqual(['python']);
    expect(observation.query.keywords).toEqual(['ai']);
  });

  it('规则命中时最终意图取规则结论', async () => {
    const observation = await observeParse('明天下雨吗');
    expect(observation.ruleIntent).toBe('off_topic');
    expect(observation.intent).toBe('off_topic');
  });

  it('产品介绍类问法由规则层拦下', async () => {
    const observation = await observeParse('你都会些啥');
    expect(observation.intent).toBe('about');
  });
});

describe('eval adapters — 答案 groundedness', () => {
  it('fixture 里的仓库都被点名，没有越界引用', () => {
    const observation = observeAnswer({
      fixture: 'evals/fixtures/search/python-ai.json',
      mustMention: ['astral-sh/ruff', 'pytorch/pytorch'],
    });
    expect(observation.mentioned).toEqual(
      expect.arrayContaining(['astral-sh/ruff', 'pytorch/pytorch']),
    );
    expect(observation.ungrounded).toEqual([]);
    expect(observation.missing).toEqual([]);
  });

  it('点名项没出现在回复里要报 missing', () => {
    const observation = observeAnswer({
      fixture: 'evals/fixtures/search/python-ai.json',
      mustMention: ['ghost/repo'],
    });
    expect(observation.missing).toEqual(['ghost/repo']);
  });

  it('同一仓库只提取一次', () => {
    const refs = extractRepoRefs(
      'https://github.com/a/b 和 https://github.com/a/b 还有 https://github.com/c/d',
    );
    expect(refs).toEqual(['a/b', 'c/d']);
  });
});

describe('eval adapters — 工具路由', () => {
  it('点名仓库 → tools/deep_dive_repo，并带出参数', () => {
    expect(observeToolRoute('深挖 astral-sh/ruff')).toEqual({
      skipped: false,
      route: 'tools',
      tool: 'deep_dive_repo',
      args: { repo: 'astral-sh/ruff' },
    });
  });

  it('普通检索落 search', () => {
    expect(observeToolRoute('本周 python 的 ai 项目')).toEqual({
      skipped: false,
      route: 'search',
    });
  });
});
