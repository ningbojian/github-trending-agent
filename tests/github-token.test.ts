import { describe, expect, it } from 'vitest';
import { resolveGithubToken, type BindingLike } from '../src/agent/github-token';

/**
 * GitHub token 解析：运营方 env → 用户 OAuth → 匿名。
 * 纯依赖注入，不碰数据库；任何一环失败都降级为匿名，绝不阻断工具调用。
 */

function setup(binding: BindingLike | Error, envToken: string | undefined = undefined) {
  const asked: string[] = [];
  return {
    asked,
    resolve: (userid: string) =>
      resolveGithubToken(userid, {
        envToken,
        loadBinding: async (id: string) => {
          asked.push(id);
          if (binding instanceof Error) throw binding;
          return binding;
        },
      }),
  };
}

describe('resolveGithubToken — 优先级', () => {
  it('有运营方 env token 时优先用它，且不读用户绑定', async () => {
    const ctx = setup({ kind: 'ok', token: 'user-token', login: 'octocat' }, 'env-token');
    const result = await ctx.resolve('zhangsan');
    expect(result).toEqual({ token: 'env-token', source: 'env' });
    expect(ctx.asked).toEqual([]);
  });

  it('env 为空字符串时当作没有', async () => {
    const ctx = setup({ kind: 'ok', token: 'user-token', login: null }, '  ');
    const result = await ctx.resolve('zhangsan');
    expect(result).toEqual({ token: 'user-token', source: 'user' });
  });

  it('没有 env 时用用户自己的 OAuth token', async () => {
    const ctx = setup({ kind: 'ok', token: 'user-token', login: 'octocat' });
    const result = await ctx.resolve('zhangsan');
    expect(result).toEqual({ token: 'user-token', source: 'user' });
    expect(ctx.asked).toEqual(['zhangsan']);
  });

  it('未绑定 → 匿名（工具仍能跑，只是限额低）', async () => {
    const ctx = setup({ kind: 'unbound' });
    expect(await ctx.resolve('zhangsan')).toEqual({ token: null, source: 'anonymous' });
  });

  it('授权过期 → 匿名，而不是报错', async () => {
    const ctx = setup({ kind: 'expired' });
    expect(await ctx.resolve('zhangsan')).toEqual({ token: null, source: 'anonymous' });
  });

  it('读绑定抛异常 → 匿名（fail-open）', async () => {
    const ctx = setup(new Error('db down'));
    expect(await ctx.resolve('zhangsan')).toEqual({ token: null, source: 'anonymous' });
  });
});
