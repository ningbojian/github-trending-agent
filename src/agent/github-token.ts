import { env } from '../config.js';

/**
 * 工具调用用哪个 GitHub token。
 *
 * 优先级：运营方 `GITHUB_TOKEN` → 用户自己的 OAuth token → 匿名。
 * 理由：运营方 token 限额最高（5000/h），读的都是公开数据，不存在越权；
 * 用户没绑定时匿名（60/h）也够「深挖一个仓库」用，绝不因为缺 token 就拒绝服务。
 *
 * 任何一环出错（DB 掉线、密文损坏、环境变量残缺）都降级为匿名并继续——
 * 工具的价值在于给出信息，不该被鉴权问题整体拖垮。授权过期要提示重新绑定，
 * 那是 handler 的事（它知道怎么发消息），这里只回答「用哪个 token」。
 */

/** 与 `github/stars.ts` 的 BindingAuth 结构兼容；单独声明避免把 DB 依赖带进本模块。 */
export type BindingLike =
  | { kind: 'unbound' }
  | { kind: 'expired' }
  | { kind: 'ok'; token: string; login: string | null };

export type TokenSource = 'env' | 'user' | 'anonymous';

export interface ResolvedGithubToken {
  token: string | null;
  source: TokenSource;
}

export interface ResolveTokenDeps {
  /** `undefined` = 读真实环境；`null` / 空串 = 明确当作没有。 */
  envToken?: string | null;
  loadBinding?: (wecomUserid: string) => Promise<BindingLike>;
}

function envTokenOrDefault(): string | null {
  try {
    return env.GITHUB_TOKEN ?? null;
  } catch {
    // 环境变量不完整（常见于单测）时按没有处理，不影响匿名调用。
    return null;
  }
}

/** 默认实现放在动态 import 里：纯函数用法（含单测与评测）不必加载 DB / 企微模块。 */
async function defaultLoadBinding(wecomUserid: string): Promise<BindingLike> {
  const { loadBindingAuth } = await import('../github/stars.js');
  return loadBindingAuth(wecomUserid);
}

export async function resolveGithubToken(
  wecomUserid: string,
  deps: ResolveTokenDeps = {},
): Promise<ResolvedGithubToken> {
  const envToken = deps.envToken === undefined ? envTokenOrDefault() : deps.envToken;
  if (envToken !== null && envToken.trim() !== '') {
    return { token: envToken.trim(), source: 'env' };
  }

  const loadBinding = deps.loadBinding ?? defaultLoadBinding;
  try {
    const binding = await loadBinding(wecomUserid);
    if (binding.kind === 'ok' && binding.token.trim() !== '') {
      return { token: binding.token, source: 'user' };
    }
  } catch (err) {
    console.warn('[github] token 解析失败，改用匿名:', err instanceof Error ? err.message : err);
  }

  return { token: null, source: 'anonymous' };
}
