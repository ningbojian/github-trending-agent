import { and, asc, eq, sql } from 'drizzle-orm';
import { loadRecentResults } from '../agent/recent-results.js';
import { db } from '../db/client.js';
import { favorites, subscribers } from '../db/schema.js';
import { sendWeComText } from '../wecom/api.js';
import { NUMBER_TOKEN_PATTERN, parseCnNumber } from '../wecom/cn-number.js';
import type { InboundMessage } from '../wecom/router.js';
import { decryptSecret } from './oauth.js';

/**
 * 收藏与 GitHub star 同步（Task 12）：
 * - starRepo / unstarRepo：GitHub starred API（204 → ok；401 → auth_failed；
 *   其他状态/网络错误 → failed，不抛出 handler）
 * - handleFavorite：「收藏 N」→ 从最近一次 search_caches 取第 N 条 →
 *   star → upsert favorites（唯一约束幂等）
 * - handleUnfavorite：「取消收藏 N」→ 取"我的收藏"第 N 条 → unstar → 删行
 * - handleList：「我的收藏」→ 编号列表（owner/repo + 创建日期），
 *   ≤1800 字节截断；读取/发送失败回「加载失败」，绝不借用空态文案
 * 未绑定（无 github_token_enc）一律引导发「绑定」，绝不写库。
 */

/** GitHub star/unstar 的结果分类（204 无法区分"本次新 star"与"早已 star"）。 */
export type StarResult = 'ok' | 'auth_failed' | 'failed';

// ---------------------------------------------------------------------------
// 交互文案（全中文，供测试逐字符断言）
// ---------------------------------------------------------------------------

/** 未绑定时的引导文案。 */
export const UNBOUND_REPLY = "先发'绑定'授权 GitHub";

/** token 失效（GitHub 401 / 密文损坏）时的引导文案。 */
export const AUTH_EXPIRED_REPLY = "授权已过期，请重新发'绑定'";

/** GitHub star 失败（非 204/401）时的通用失败文案。 */
export const STAR_FAILURE_REPLY = '收藏失败，请稍后再试';

/**
 * star 同步失败但本地已记下时的文案。
 * 「收藏」的产品语义仍是 GitHub star，但「别再推它」这件事不该被一次网络抖动吃掉。
 */
export const STAR_SYNC_FAILED_REPLY =
  '⚠️ 已记下，但同步 GitHub 失败（不影响以后不再推它）；稍后可再发「收藏 N」重试。';

/** GitHub unstar 失败（非 204/401）时的通用失败文案。 */
export const UNSTAR_FAILURE_REPLY = '取消收藏失败，请稍后再试';

/** 「我的收藏」为空时的友好空态文案。 */
export const EMPTY_FAVORITES_REPLY =
  "你还没有收藏任何项目。先搜索一下，再回复'收藏 N'即可收藏并同步 star。";

/** 「收藏 N」序号无法解析（如 收藏 0）时的用法提示（router 疑似命令路径共用同一文案）。 */
export const FAVORITE_USAGE_REPLY =
  '用法：「收藏 N」，N 为 1 起的数字，例如：收藏 1';

/** 「取消收藏 N」序号无法解析时的用法提示。 */
export const UNFAVORITE_USAGE_REPLY =
  '用法：「取消收藏 N」，N 为 1 起的数字，例如：取消收藏 1';

/** 无 search_caches 行（从未搜索、也未收到过简报缓存）时的引导文案。 */
export const NO_SEARCH_CACHE_REPLY =
  '还没有可收藏的结果，先搜索，或等今天的简报（简报里的项目也能收藏）';

/** 有缓存行但最近一次结果为空时的文案。 */
export const EMPTY_SEARCH_CACHE_REPLY = '最近一次结果为空，请重新搜索';

/**
 * 「取消收藏 N」的序号上限：「我的收藏」列表可远超 25 条，
 * 删除编号不受「收藏 N」的缓存 topN 上限（25）约束。
 */
export const MAX_UNFAVORITE_N = 999;

/** 「我的收藏」读取/发送失败的兜底文案（绝不冒充空态，不谎报"没有收藏"）。 */
export const LIST_FAILURE_REPLY = '加载失败，请稍后再试';

/** 未绑定时附在本地列表后的引导（star 存在 GitHub，不绑定就只有本地收藏）。 */
export const UNBOUND_STARS_NOTE = '绑定 GitHub 后这里会显示你全部 star';

/** 已绑定但拉不到 GitHub 时的回退说明（如实告知这是本地收藏，不是全部 star）。 */
export const STARS_FALLBACK_NOTE =
  '暂时读不到 GitHub star，下面是本服务里收藏过的项目';

/** 企微文本消息上限 ~2048 字节；1800 字节为安全阈值，超出即从尾部丢弃条目。 */
const MAX_LIST_BYTES = 1800;

/** 「我的收藏」一次展示的 star 条数（不实现翻页，其余去 GitHub 看）。 */
const GITHUB_STARS_PAGE_SIZE = 10;

/** 列表截断标注（与 reply.ts 的截断纪律一致，文案区分场景）。 */
const LIST_TRUNCATION_NOTE = '（内容过长，已截断）';

/** 收藏越界文案：缓存存在但最近一次结果不足 N 条（区分"从未缓存"的引导文案）。 */
function favoriteOutOfRangeReply(n: number, total: number): string {
  return `最近一次结果只有 ${total} 条，没有第 ${n} 条`;
}

/** 「我的收藏」越界文案（列表本体存在，只是不足 N 条）。 */
function outOfRangeReply(n: number): string {
  return `没有第 ${n} 条`;
}

/**
 * star 多于已展示的 10 条时的越界文案：明说只列了最近 10 个，
 * 而不是谎称"没有第 N 条"（用户确实有那一条 star）。
 */
function githubOutOfRangeReply(n: number, login: string): string {
  return `只列出了最近 ${GITHUB_STARS_PAGE_SIZE} 个 star，第 ${n} 个请到 GitHub 取消：https://github.com/${login}?tab=stars`;
}

// ---------------------------------------------------------------------------
// GitHub starred API
// ---------------------------------------------------------------------------

const GITHUB_STARRED_BASE = 'https://api.github.com/user/starred';

/**
 * star 一个仓库（PUT /user/starred/{owner}/{repo}）。
 * - 204 → 'ok'（GitHub API 不区分"本次新 star"与"早已 star"；
 *   favorites 表唯一约束 + upsert 提供幂等）
 * - 401 → 'auth_failed'
 * - 其他状态 / 网络错误 → 'failed'（log warn，不抛出，绝不冲出 handler）
 */
export async function starRepo(token: string, fullName: string): Promise<StarResult> {
  try {
    const res = await fetch(`${GITHUB_STARRED_BASE}/${fullName}`, {
      method: 'PUT',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
    });
    if (res.status === 204) {
      return 'ok';
    }
    if (res.status === 401) {
      return 'auth_failed';
    }
    console.warn(`starRepo ${fullName}: HTTP ${res.status}`);
    return 'failed';
  } catch (err) {
    console.warn(`starRepo ${fullName}: ${String(err)}`);
    return 'failed';
  }
}

/**
 * 取消 star 一个仓库（DELETE /user/starred/{owner}/{repo}）。
 * 状态语义与 starRepo 完全一致（204 → ok，401 → auth_failed，其余 failed 不抛出）。
 */
export async function unstarRepo(token: string, fullName: string): Promise<StarResult> {
  try {
    const res = await fetch(`${GITHUB_STARRED_BASE}/${fullName}`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
    });
    if (res.status === 204) {
      return 'ok';
    }
    if (res.status === 401) {
      return 'auth_failed';
    }
    console.warn(`unstarRepo ${fullName}: HTTP ${res.status}`);
    return 'failed';
  } catch (err) {
    console.warn(`unstarRepo ${fullName}: ${String(err)}`);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// GitHub star 列表（只读）
// ---------------------------------------------------------------------------

/** GitHub star 条目（只消费 full_name，链接由它派生）。 */
export interface GithubStarItem {
  fullName: string;
}

export type GithubStarsResult =
  | { kind: 'ok'; items: GithubStarItem[]; total: number }
  | { kind: 'auth_failed' }
  | { kind: 'failed' };

/**
 * star 列表端点用**公开用户端点** `/users/{login}/starred`：
 * `GET /user/starred` 对 OAuth App 需要 `user` 权限，而我们的 token 只有
 * `public_repo`——改权限会让已绑定用户全部重新授权。公开端点不需要额外 scope，
 * 代价是只看得见 star 的**公开**仓库（绝大多数情况就是全部）。
 * 仍然带上 token：公开端点不校验它，但认证请求的速率额度是匿名的 60 倍。
 */
function starsEndpoint(login: string): string {
  return `https://api.github.com/users/${encodeURIComponent(login)}/starred`;
}

/** 从 `Link` 头解析 `rel="last"` 的页码（配合 per_page=1 即为 star 总数）。 */
function parseLastPage(linkHeader: string | null): number | null {
  if (!linkHeader) {
    return null;
  }
  const match = /[?&]page=(\d+)[^>]*>\s*;\s*rel="last"/.exec(linkHeader);
  return match ? Number(match[1]) : null;
}

/**
 * 读某个 GitHub 用户的 star（按 star 时间倒序，前 10 个 + 总数）。
 * - 401 → 'auth_failed'（token 失效，引导重新绑定）
 * - 其余非 200 / 网络错误 → 'failed'（调用方回退本地收藏，绝不冒充"没有 star"）
 * - 不足 10 条时跳过统计请求（无 Link 时总数即本次条数）
 */
export async function loadGithubStars(
  login: string,
  token: string,
): Promise<GithubStarsResult> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
  };
  try {
    const res = await fetch(
      `${starsEndpoint(login)}?sort=created&direction=desc&per_page=${GITHUB_STARS_PAGE_SIZE}`,
      { headers },
    );
    if (res.status === 401) {
      return { kind: 'auth_failed' };
    }
    if (res.status !== 200) {
      console.warn(`loadGithubStars ${login}: HTTP ${res.status}`);
      return { kind: 'failed' };
    }
    const raw: unknown = await res.json();
    const items: GithubStarItem[] = Array.isArray(raw)
      ? raw
          .filter((row): row is { full_name: unknown } => typeof row === 'object' && row !== null)
          .map((row) => ({ fullName: String((row as { full_name?: unknown }).full_name ?? '') }))
          .filter((item) => item.fullName.length > 0)
      : [];

    let total = items.length;
    if (items.length >= GITHUB_STARS_PAGE_SIZE) {
      // 第 11 条以后不展示，但总数决定尾行「还有 N 个」——统计失败时宁可不显示尾行。
      try {
        const countRes = await fetch(`${starsEndpoint(login)}?per_page=1`, { headers });
        if (countRes.status === 200) {
          const lastPage = parseLastPage(countRes.headers.get('link'));
          if (lastPage !== null) {
            total = lastPage;
          }
        } else {
          console.warn(`loadGithubStars count ${login}: HTTP ${countRes.status}`);
        }
      } catch (err) {
        console.warn(`loadGithubStars count ${login}: ${String(err)}`);
      }
    }
    return { kind: 'ok', items, total };
  } catch (err) {
    console.warn(`loadGithubStars ${login}: ${String(err)}`);
    return { kind: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// DB 访问（全部经 db()，测试以 mock 桩替换）
// ---------------------------------------------------------------------------

/** 订阅者的 GitHub 绑定状态：token 密文与登录名（都没有则为 null）。 */
interface GithubBinding {
  tokenEnc: string | null;
  login: string | null;
}

/** 读订阅者的绑定状态；无订阅者行或未绑定时均为 null 字段。 */
async function loadBinding(wecomUserid: string): Promise<GithubBinding> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, wecomUserid));
  const row = rows[0];
  const tokenEnc = row?.githubTokenEnc;
  const login = row?.githubLogin;
  return {
    tokenEnc: tokenEnc == null ? null : String(tokenEnc),
    login: login == null ? null : String(login),
  };
}

/** 读订阅者的加密 token；无订阅者行或未绑定时返回 null。 */
async function loadTokenEnc(wecomUserid: string): Promise<string | null> {
  return (await loadBinding(wecomUserid)).tokenEnc;
}

/** 绑定态三分类：未绑定 / 密文损坏（引导重新绑定）/ 可用 token。 */
export type BindingAuth =
  | { kind: 'unbound' }
  | { kind: 'expired' }
  | { kind: 'ok'; token: string; login: string | null };

/**
 * 读并解密 token；解密失败按"授权过期"处理（密钥轮换 / 密文被篡改）。
 * 导出给推送路径用：它需要在读画像时顺带拉一次网页端 star 名单。
 */
export async function loadBindingAuth(wecomUserid: string): Promise<BindingAuth> {
  const binding = await loadBinding(wecomUserid);
  if (binding.tokenEnc === null) {
    return { kind: 'unbound' };
  }
  try {
    return {
      kind: 'ok',
      token: decryptSecret(binding.tokenEnc),
      login: binding.login,
    };
  } catch (err) {
    console.warn('github token decrypt failed:', err);
    return { kind: 'expired' };
  }
}

/** 读调用方的"我的收藏"列表（按创建时间升序，序号稳定）。 */
async function loadFavorites(
  wecomUserid: string,
): Promise<Array<{ fullName: string; createdAt: Date }>> {
  const rows = await db()
    .select()
    .from(favorites)
    .where(eq(favorites.wecomUserid, wecomUserid))
    .orderBy(asc(favorites.createdAt), asc(favorites.id));
  return rows.map((row) => ({
    fullName: row.fullName,
    createdAt: row.createdAt,
  }));
}

/**
 * upsert 收藏行：唯一约束 (wecom_userid, full_name) 冲突时只把同步状态「或」上去。
 *
 * 必须取或而不是覆盖：先记 false（保证「别再推它」立刻生效），star 成功后再改 true；
 * 若某次 star 失败又把 true 写回去，之前同步成功的记录就被降级了。
 */
export async function upsertFavorite(
  wecomUserid: string,
  fullName: string,
  starredOnGithub: boolean,
): Promise<void> {
  await db()
    .insert(favorites)
    .values({ wecomUserid, fullName, starredOnGithub })
    .onConflictDoUpdate({
      target: [favorites.wecomUserid, favorites.fullName],
      set: { starredOnGithub: sql`${favorites.starredOnGithub} or ${starredOnGithub}` },
    });
}

/**
 * 删除收藏行（取消收藏成功后调用）。
 * 导出给面板复用：面板的「取消收藏」必须与聊天命令走同一条写路径。
 */
export async function deleteFavorite(wecomUserid: string, fullName: string): Promise<void> {
  await db()
    .delete(favorites)
    .where(
      and(eq(favorites.wecomUserid, wecomUserid), eq(favorites.fullName, fullName)),
    );
}

/** 「收藏」写路径的结局（面板与聊天共用同一套文案映射）。 */
export type FavoriteWriteResult = 'synced' | 'auth_failed' | 'sync_failed';

/**
 * 收藏一个已经确定 fullName 的仓库：先落本地行，再同步 GitHub star。
 *
 * 顺序不能反：网络/授权再出问题，「这个仓库以后别再推」这条信号也不能丢。
 * 聊天里的「收藏 N」与面板里的「收藏」按钮都走这里，避免两处各写一遍。
 */
export async function favoriteRepo(
  wecomUserid: string,
  token: string,
  fullName: string,
): Promise<FavoriteWriteResult> {
  await upsertFavorite(wecomUserid, fullName, false);
  const result = await starRepo(token, fullName);
  if (result === 'ok') {
    await upsertFavorite(wecomUserid, fullName, true);
    return 'synced';
  }
  return result === 'auth_failed' ? 'auth_failed' : 'sync_failed';
}

/** 「取消收藏」写路径的结局。 */
export type UnfavoriteWriteResult = 'removed' | 'auth_failed' | 'failed';

/**
 * 取消一个已经确定 fullName 的收藏：GitHub 确认取消后才删本地行。
 * 失败时保留本地行——GitHub 侧未确认，删了就会「以为取消、其实还 star 着」。
 */
export async function unfavoriteRepo(
  wecomUserid: string,
  token: string,
  fullName: string,
): Promise<UnfavoriteWriteResult> {
  const result = await unstarRepo(token, fullName);
  if (result === 'ok') {
    await deleteFavorite(wecomUserid, fullName);
    return 'removed';
  }
  return result === 'auth_failed' ? 'auth_failed' : 'failed';
}

// ---------------------------------------------------------------------------
// 消息 handler
// ---------------------------------------------------------------------------

/** 「取消收藏 <数字>」——与 router 的分发正则保持一致（中文数字与阿拉伯数字同权）。 */
const UNFAVORITE_PATTERN = new RegExp(`^取消收藏\\s*(${NUMBER_TOKEN_PATTERN})$`);

/** 「收藏 <数字>」——与 router 的分发正则保持一致。 */
const FAVORITE_PATTERN = new RegExp(`^收藏\\s*(${NUMBER_TOKEN_PATTERN})$`);

/**
 * 「收藏 N」handler：
 * 1. 未绑定（无 github_token_enc）→ 引导绑定，不写库
 * 2. 序号无法解析（如「收藏 0」）→ 用法提示
 * 3. 读最近一次 search_caches 三态：无行 → 引导搜索/简报；空行 → 重新搜索；
 *    越界 → 「最近一次结果只有 M 条，没有第 N 条」
 * 4. 先落 favorites（starred_on_github=false），再 starRepo：
 *    'ok' → 改 true + 中文成功回复；'auth_failed' → 授权过期引导；
 *    'failed' → 「已记下，但同步失败」——本地行保留，这个仓库以后不再推
 */
export async function handleFavorite(msg: InboundMessage): Promise<void> {
  try {
    const match = FAVORITE_PATTERN.exec(msg.content.trim());
    if (!match) {
      return;
    }
    const n = parseCnNumber(match[1] ?? '');
    if (n === null) {
      await sendWeComText(msg.fromUserName, FAVORITE_USAGE_REPLY);
      return;
    }

    const tokenEnc = await loadTokenEnc(msg.fromUserName);
    if (!tokenEnc) {
      await sendWeComText(msg.fromUserName, UNBOUND_REPLY);
      return;
    }

    const cache = await loadRecentResults(msg.fromUserName);
    if (!cache.found) {
      await sendWeComText(msg.fromUserName, NO_SEARCH_CACHE_REPLY);
      return;
    }
    if (cache.items.length === 0) {
      await sendWeComText(msg.fromUserName, EMPTY_SEARCH_CACHE_REPLY);
      return;
    }
    const item = cache.items[n - 1];
    if (!item) {
      await sendWeComText(
        msg.fromUserName,
        favoriteOutOfRangeReply(n, cache.items.length),
      );
      return;
    }

    let token: string;
    try {
      token = decryptSecret(tokenEnc);
    } catch (err) {
      // 密文损坏 / 密钥轮换：按授权失效引导重新绑定。
      console.warn('favorite token decrypt failed:', err);
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }

    // 先落库：网络/授权再出问题，「这个仓库以后别再推」这条信号也不会丢。
    const result = await favoriteRepo(msg.fromUserName, token, item.fullName);
    if (result === 'auth_failed') {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }
    if (result === 'sync_failed') {
      await sendWeComText(msg.fromUserName, STAR_SYNC_FAILED_REPLY);
      return;
    }

    await sendWeComText(
      msg.fromUserName,
      `✅ 已收藏 ${item.fullName}，已同步到你的 GitHub`,
    );
  } catch (err) {
    console.error('handleFavorite failed:', err);
    try {
      await sendWeComText(msg.fromUserName, STAR_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 连兜底发送也失败：仅记日志，吞掉不重试（防递归）。
      console.error('favorite fallback reply failed:', fallbackErr);
    }
  }
}

/**
 * 「取消收藏 N」handler：
 * 1. 已绑定 → 序号按 GitHub star 列表（时间倒序）解析，与「我的收藏」显示完全一致；
 *    未绑定 / 拉取失败 → 回退本地 favorites（created_at 升序）
 * 2. 越界 → 「没有第 N 条」；star 多于已展示的 10 条时改为引导去 GitHub 取消
 * 3. 未绑定 → 引导绑定，不删行
 * 4. unstarRepo → 'ok' → 删 favorites 行 → 「已取消收藏 owner/repo」
 *    'auth_failed' / 'failed' 均不删行（GitHub 侧未确认取消）。
 */
export async function handleUnfavorite(msg: InboundMessage): Promise<void> {
  try {
    const match = UNFAVORITE_PATTERN.exec(msg.content.trim());
    if (!match) {
      return;
    }
    // 「我的收藏」可远超 25 条：删除序号用更宽上限（收藏仍默认 25）。
    const n = parseCnNumber(match[1] ?? '', { max: MAX_UNFAVORITE_N });
    if (n === null) {
      await sendWeComText(msg.fromUserName, UNFAVORITE_USAGE_REPLY);
      return;
    }

    const auth = await loadBindingAuth(msg.fromUserName);
    if (auth.kind === 'expired') {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }

    let fullName: string | null = null;
    if (auth.kind === 'ok' && auth.login !== null) {
      const stars = await loadGithubStars(auth.login, auth.token);
      if (stars.kind === 'auth_failed') {
        await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
        return;
      }
      if (stars.kind === 'ok') {
        const item = stars.items[n - 1];
        if (!item) {
          await sendWeComText(
            msg.fromUserName,
            stars.total > stars.items.length
              ? githubOutOfRangeReply(n, auth.login)
              : outOfRangeReply(n),
          );
          return;
        }
        fullName = item.fullName;
      }
    }

    if (fullName === null) {
      // 回退：本地 favorites（asc）。越界判定先于未绑定引导（保持原有优先级）。
      const rows = await loadFavorites(msg.fromUserName);
      const row = rows[n - 1];
      if (!row) {
        await sendWeComText(msg.fromUserName, outOfRangeReply(n));
        return;
      }
      if (auth.kind !== 'ok') {
        await sendWeComText(msg.fromUserName, UNBOUND_REPLY);
        return;
      }
      fullName = row.fullName;
    }

    if (auth.kind !== 'ok') {
      // 防御性短路：上面两条路径都已在未绑定时返回。
      await sendWeComText(msg.fromUserName, UNBOUND_REPLY);
      return;
    }

    const result = await unfavoriteRepo(msg.fromUserName, auth.token, fullName);
    if (result === 'auth_failed') {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }
    if (result !== 'removed') {
      await sendWeComText(msg.fromUserName, UNSTAR_FAILURE_REPLY);
      return;
    }

    await sendWeComText(msg.fromUserName, `已取消收藏 ${fullName}`);
  } catch (err) {
    console.error('handleUnfavorite failed:', err);
    try {
      await sendWeComText(msg.fromUserName, UNSTAR_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('unfavorite fallback reply failed:', fallbackErr);
    }
  }
}

/** 时间戳 → 'YYYY-MM-DD'（PG timestamp 序列化为 Date）。 */
function formatDate(value: Date): string {
  const d = new Date(value);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function buildListReply(
  lines: string[],
  truncated: boolean,
  note?: string,
): string {
  const parts = ['你的收藏：', ...lines];
  if (truncated) {
    parts.push(LIST_TRUNCATION_NOTE);
  }
  if (note) {
    parts.push(note);
  }
  return parts.join('\n');
}

/**
 * 把「我的收藏」编号列表格式化为 ≤1800 字节（企微 ~2048 字节上限的安全阈值）的文本。
 * 超限时从尾部逐条丢弃，并追加「（内容过长，已截断）」标注——与 reply.ts 的
 * formatSearchReply 同一截断纪律（保靠前、丢靠后）。
 */
function formatFavoritesList(
  rows: Array<{ fullName: string; createdAt: Date }>,
  note?: string,
): string {
  const allLines = rows.map(
    (row, i) => `${i + 1}. ${row.fullName}（${formatDate(row.createdAt)}）`,
  );
  let lines = allLines;
  let text = buildListReply(lines, false, note);
  if (byteLength(text) <= MAX_LIST_BYTES) {
    return text;
  }
  while (lines.length > 0) {
    lines = lines.slice(0, -1);
    text = buildListReply(lines, true, note);
    if (byteLength(text) <= MAX_LIST_BYTES) {
      return text;
    }
  }
  // 理论不可达：表头 + 截断标注本身远小于 1800 字节。
  return text;
}

/**
 * 把 GitHub star 列表格式化为 ≤1800 字节的文本：
 * 每行 `N. owner/repo <裸链接>`（个人微信里可直接点），末行「还有 N 个 · 在 GitHub 看全部」。
 * 截断时「还有 N 个」按**实际展示条数**重算（剩余 = 总数 - 展示数），绝不虚报。
 */
export function formatGithubStarsList(
  items: GithubStarItem[],
  total: number,
  login: string,
): string {
  const allLines = items.map(
    (item, i) =>
      `${i + 1}. ${item.fullName} https://github.com/${item.fullName}`,
  );
  const build = (kept: number): string => {
    const parts = ['你的 star：', ...allLines.slice(0, kept)];
    if (kept < allLines.length) {
      parts.push(LIST_TRUNCATION_NOTE);
    }
    const remaining = total - kept;
    if (remaining > 0) {
      parts.push(
        `还有 ${remaining} 个 · 在 GitHub 看全部 https://github.com/${login}?tab=stars`,
      );
    }
    return parts.join('\n');
  };

  let kept = allLines.length;
  let text = build(kept);
  while (kept > 0 && byteLength(text) > MAX_LIST_BYTES) {
    kept -= 1;
    text = build(kept);
  }
  return text;
}

/** 本地收藏列表（未绑定 / GitHub 拉取失败时的回退），末尾附一行如实说明。 */
async function sendLocalFavorites(
  wecomUserid: string,
  note: string,
): Promise<void> {
  const rows = await loadFavorites(wecomUserid);
  if (rows.length === 0) {
    await sendWeComText(wecomUserid, `${EMPTY_FAVORITES_REPLY}\n${note}`);
    return;
  }
  await sendWeComText(wecomUserid, formatFavoritesList(rows, note));
}

/**
 * 「我的收藏」handler：**以 GitHub star 为准**。
 * - 已绑定 → GitHub 实时列表（最近 10 个 + 总数 + 「看全部」链接）
 * - 未绑定 → 本地 favorites（asc）+ 一行"绑定后显示全部 star"
 * - 拉取失败 → 回退本地列表并如实说明（绝不谎报为空）
 * - token 失效（401 / 密文损坏）→ 引导重新绑定
 * 读取或发送失败回「加载失败，请稍后再试」——失败兜底绝不借用空态文案。
 */
export async function handleList(msg: InboundMessage): Promise<void> {
  try {
    const auth = await loadBindingAuth(msg.fromUserName);
    if (auth.kind === 'expired') {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }
    if (auth.kind === 'ok' && auth.login !== null) {
      const stars = await loadGithubStars(auth.login, auth.token);
      if (stars.kind === 'auth_failed') {
        await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
        return;
      }
      if (stars.kind === 'ok') {
        if (stars.items.length === 0) {
          await sendWeComText(msg.fromUserName, EMPTY_FAVORITES_REPLY);
          return;
        }
        await sendWeComText(
          msg.fromUserName,
          formatGithubStarsList(stars.items, stars.total, auth.login),
        );
        return;
      }
      await sendLocalFavorites(msg.fromUserName, STARS_FALLBACK_NOTE);
      return;
    }
    // 未绑定：本地收藏 + 绑定引导；已绑定但缺 login（历史行）→ 按"读不到"如实说明。
    await sendLocalFavorites(
      msg.fromUserName,
      auth.kind === 'unbound' ? UNBOUND_STARS_NOTE : STARS_FALLBACK_NOTE,
    );
  } catch (err) {
    console.error('handleList failed:', err);
    // 失败兜底：与空态文案严格区分，保证用户收到的是"稍后再试"而非"没有收藏"。
    try {
      await sendWeComText(msg.fromUserName, LIST_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('list fallback reply failed:', fallbackErr);
    }
  }
}
