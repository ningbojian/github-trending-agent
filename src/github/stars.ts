import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { favorites, searchCaches, subscribers } from '../db/schema';
import { sendWeComText } from '../wecom/api';
import type { InboundMessage } from '../wecom/router';
import { decryptSecret } from './oauth';

/**
 * 收藏与 GitHub star 同步（Task 12）：
 * - starRepo / unstarRepo：GitHub starred API（204 → ok；401 → auth_failed；
 *   其他状态/网络错误 → failed，不抛出 handler）
 * - handleFavorite：「收藏 N」→ 从最近一次 search_caches 取第 N 条 →
 *   star → upsert favorites（唯一约束幂等）
 * - handleUnfavorite：「取消收藏 N」→ 取"我的收藏"第 N 条 → unstar → 删行
 * - handleList：「我的收藏」→ 编号列表（owner/repo + 创建日期）
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

/** GitHub unstar 失败（非 204/401）时的通用失败文案。 */
export const UNSTAR_FAILURE_REPLY = '取消收藏失败，请稍后再试';

/** 「我的收藏」为空时的友好空态文案。 */
export const EMPTY_FAVORITES_REPLY =
  "你还没有收藏任何项目。先搜索一下，再回复'收藏 N'即可收藏并同步 star。";

/** 序号越界文案（没有第 N 条）。 */
function outOfRangeReply(n: number): string {
  return `没有第 ${n} 条`;
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
// DB 访问（全部经 db()，测试以 mock 桩替换）
// ---------------------------------------------------------------------------

/** 读订阅者的加密 token；无订阅者行或未绑定时返回 null。 */
async function loadTokenEnc(wecomUserid: string): Promise<string | null> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, wecomUserid));
  const enc = rows[0]?.githubTokenEnc;
  return enc == null ? null : String(enc);
}

/** 读调用方最近一次检索缓存（search_caches 每用户至多一行，仍按创建时间倒序兜底）。 */
async function loadLatestSearchResults(
  wecomUserid: string,
): Promise<SearchCacheItem[]> {
  const rows = await db()
    .select()
    .from(searchCaches)
    .where(eq(searchCaches.wecomUserid, wecomUserid))
    .orderBy(desc(searchCaches.createdAt))
    .limit(1);
  const results = rows[0]?.results;
  return Array.isArray(results) ? (results as SearchCacheItem[]) : [];
}

/** 缓存条目只需 full_name；其余字段由 Task 8/9 写入，这里不消费。 */
interface SearchCacheItem {
  fullName: string;
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

/** upsert 收藏行：唯一约束 (wecom_userid, full_name) 冲突时仅刷新同步状态。 */
async function upsertFavorite(wecomUserid: string, fullName: string): Promise<void> {
  await db()
    .insert(favorites)
    .values({ wecomUserid, fullName, starredOnGithub: true })
    .onConflictDoUpdate({
      target: [favorites.wecomUserid, favorites.fullName],
      set: { starredOnGithub: true },
    });
}

/** 删除收藏行（取消收藏成功后调用）。 */
async function deleteFavorite(wecomUserid: string, fullName: string): Promise<void> {
  await db()
    .delete(favorites)
    .where(
      and(eq(favorites.wecomUserid, wecomUserid), eq(favorites.fullName, fullName)),
    );
}

// ---------------------------------------------------------------------------
// 消息 handler
// ---------------------------------------------------------------------------

/** 「收藏 <数字>」——与 router 的分发正则保持一致。 */
const FAVORITE_PATTERN = /^收藏\s*(\d+)$/;

/** 「取消收藏 <数字>」。 */
const UNFAVORITE_PATTERN = /^取消收藏\s*(\d+)$/;

/**
 * 「收藏 N」handler：
 * 1. 未绑定（无 github_token_enc）→ 引导绑定，不写库
 * 2. 从最近一次 search_caches 取第 N 条；越界 → 「没有第 N 条」
 * 3. 解密 token → starRepo → 'ok' → upsert favorites → 中文成功回复
 *    'auth_failed' → 授权已过期引导（不写 favorites）；'failed' → 通用失败文案
 */
export async function handleFavorite(msg: InboundMessage): Promise<void> {
  try {
    const match = FAVORITE_PATTERN.exec(msg.content.trim());
    if (!match) {
      return;
    }
    const n = Number(match[1]);

    const tokenEnc = await loadTokenEnc(msg.fromUserName);
    if (!tokenEnc) {
      await sendWeComText(msg.fromUserName, UNBOUND_REPLY);
      return;
    }

    const items = await loadLatestSearchResults(msg.fromUserName);
    const item = items[n - 1];
    if (!item) {
      await sendWeComText(msg.fromUserName, outOfRangeReply(n));
      return;
    }

    let token: string;
    try {
      token = decryptSecret(tokenEnc);
    } catch {
      // 密文损坏 / 密钥轮换：按授权失效引导重新绑定。
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }

    const result = await starRepo(token, item.fullName);
    if (result === 'auth_failed') {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }
    if (result !== 'ok') {
      await sendWeComText(msg.fromUserName, STAR_FAILURE_REPLY);
      return;
    }

    await upsertFavorite(msg.fromUserName, item.fullName);
    await sendWeComText(
      msg.fromUserName,
      `✅ 已收藏 ${item.fullName}，已同步到你的 GitHub`,
    );
  } catch (err) {
    console.error('handleFavorite failed:', err);
    try {
      await sendWeComText(msg.fromUserName, STAR_FAILURE_REPLY);
    } catch {
      // 连兜底发送也失败：吞掉，避免异常传播到 router 的 catch。
    }
  }
}

/**
 * 「取消收藏 N」handler：
 * 1. 列"我的收藏"（created_at 升序），越界 → 「没有第 N 条」
 * 2. 未绑定 → 引导绑定，不删行
 * 3. unstarRepo → 'ok' → 删 favorites 行 → 「已取消收藏 owner/repo」
 *    'auth_failed' / 'failed' 均不删行（GitHub 侧未确认取消）。
 */
export async function handleUnfavorite(msg: InboundMessage): Promise<void> {
  try {
    const match = UNFAVORITE_PATTERN.exec(msg.content.trim());
    if (!match) {
      return;
    }
    const n = Number(match[1]);

    const rows = await loadFavorites(msg.fromUserName);
    const row = rows[n - 1];
    if (!row) {
      await sendWeComText(msg.fromUserName, outOfRangeReply(n));
      return;
    }

    const tokenEnc = await loadTokenEnc(msg.fromUserName);
    if (!tokenEnc) {
      await sendWeComText(msg.fromUserName, UNBOUND_REPLY);
      return;
    }

    let token: string;
    try {
      token = decryptSecret(tokenEnc);
    } catch {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }

    const result = await unstarRepo(token, row.fullName);
    if (result === 'auth_failed') {
      await sendWeComText(msg.fromUserName, AUTH_EXPIRED_REPLY);
      return;
    }
    if (result !== 'ok') {
      await sendWeComText(msg.fromUserName, UNSTAR_FAILURE_REPLY);
      return;
    }

    await deleteFavorite(msg.fromUserName, row.fullName);
    await sendWeComText(msg.fromUserName, `已取消收藏 ${row.fullName}`);
  } catch (err) {
    console.error('handleUnfavorite failed:', err);
    try {
      await sendWeComText(msg.fromUserName, UNSTAR_FAILURE_REPLY);
    } catch {
      // 吞掉兜底发送失败，避免异常传播到 router 的 catch。
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

/**
 * 「我的收藏」handler：编号列表（owner/repo + 创建日期）；空列表回友好空态文案。
 */
export async function handleList(msg: InboundMessage): Promise<void> {
  try {
    const rows = await loadFavorites(msg.fromUserName);
    if (rows.length === 0) {
      await sendWeComText(msg.fromUserName, EMPTY_FAVORITES_REPLY);
      return;
    }
    const lines = rows.map(
      (row, i) => `${i + 1}. ${row.fullName}（${formatDate(row.createdAt)}）`,
    );
    await sendWeComText(msg.fromUserName, `你的收藏：\n${lines.join('\n')}`);
  } catch (err) {
    console.error('handleList failed:', err);
    // 空态文案兼作兜底：保证用户总能收到某种中文回复。
    try {
      await sendWeComText(msg.fromUserName, EMPTY_FAVORITES_REPLY);
    } catch {
      // 吞掉兜底发送失败。
    }
  }
}
