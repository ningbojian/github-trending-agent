import { describe, expect, it } from 'vitest';
import { findRepoRef, routeToTools } from '../src/wecom/tool-route';

/**
 * 工具路由的规则前置：只有「确实需要工具」的说法才进入模型循环。
 *
 * 这条规则的价值有一半在**否定**：普通检索（「本周 python 的 ai 项目」）
 * 绝不能因为多了一个斜杠或一句「怎么样」就去调模型——那既慢又花钱。
 */

describe('findRepoRef', () => {
  it('识别 owner/repo 与 GitHub 链接', () => {
    expect(findRepoRef('深挖 astral-sh/ruff')).toBe('astral-sh/ruff');
    expect(findRepoRef('看看 https://github.com/facebook/react/tree/main')).toBe(
      'https://github.com/facebook/react/tree/main',
    );
  });

  it('纯数字斜杠（日期/比分）不算仓库', () => {
    expect(findRepoRef('10/27 有什么新项目')).toBeNull();
    expect(findRepoRef('2/3 的项目都在涨')).toBeNull();
  });

  it('没有斜杠就没有仓库引用', () => {
    expect(findRepoRef('本周 python 的 ai 项目')).toBeNull();
  });
});

describe('routeToTools — 正例', () => {
  it('深挖某个仓库 → deep_dive_repo', () => {
    expect(routeToTools('深挖 astral-sh/ruff')).toEqual({
      kind: 'tools',
      tool: 'deep_dive_repo',
      repo: 'astral-sh/ruff',
    });
  });

  it('贴链接也算是深挖', () => {
    expect(routeToTools('https://github.com/facebook/react')).toEqual({
      kind: 'tools',
      tool: 'deep_dive_repo',
      repo: 'https://github.com/facebook/react',
    });
  });

  it('「靠不靠谱」+ 这个项目 → repo_health（不要求点名）', () => {
    expect(routeToTools('这个项目靠不靠谱')).toEqual({
      kind: 'tools',
      tool: 'repo_health',
      repo: null,
    });
  });

  it('仓库 + 维护问题 → repo_health，并带上仓库名', () => {
    expect(routeToTools('astral-sh/ruff 还在维护吗')).toEqual({
      kind: 'tools',
      tool: 'repo_health',
      repo: 'astral-sh/ruff',
    });
  });

  it('「帮我取消订阅 rpa」→ manage_subscription', () => {
    expect(routeToTools('帮我取消订阅 rpa')).toEqual({
      kind: 'tools',
      tool: 'manage_subscription',
      repo: null,
    });
  });

  it('「把订阅里的 rpa 删掉」→ manage_subscription', () => {
    expect(routeToTools('把订阅里的 rpa 删掉')).toEqual({
      kind: 'tools',
      tool: 'manage_subscription',
      repo: null,
    });
  });
});

describe('routeToTools — 反例（必须留在零模型路径）', () => {
  it('普通检索', () => {
    expect(routeToTools('本周 python 的 ai 项目')).toEqual({ kind: 'search' });
  });

  it('结构清晰的检索', () => {
    expect(routeToTools('前 5 个新项目')).toEqual({ kind: 'search' });
  });

  it('「类似的项目」是检索，不是深挖', () => {
    expect(routeToTools('找一下 astral-sh/ruff 类似的项目')).toEqual({ kind: 'search' });
  });

  it('「每天 9 点」不是工具', () => {
    expect(routeToTools('每天 9 点')).toEqual({ kind: 'search' });
  });

  it('泛泛的「怎么样」没有仓库名 → 检索', () => {
    expect(routeToTools('最近怎么样')).toEqual({ kind: 'search' });
  });

  it('只问订阅、没有修改动词（且撑到这一步）→ 检索', () => {
    expect(routeToTools('订阅里的词是什么意思')).toEqual({ kind: 'search' });
  });
});
