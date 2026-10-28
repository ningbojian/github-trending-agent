import { tileBase64 } from './tiles.js';

/**
 * 缩略图解析：先取仓库所有者头像，失败/超时/上游返回非图片时回退语言色块。
 *
 * 被两个地方共用：
 * - `api/tile`（生产出口，企微抓图用）；
 * - 临时格式探针（预览时提供同一套图片，测的就是最终效果）。
 *
 * 只接受 GitHub 用户名形态的 owner，上游主机写死 github.com——不做通用代理，
 * 避免变成可被利用的 SSRF 跳板。
 */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** 头像取不到时的上游等待上限：微信侧等不了太久，宁可早回退。 */
export const AVATAR_TIMEOUT_MS = 1200;

/** 头像一周；语言色块一天（素材可能随代码更新）。 */
export const AVATAR_CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';
export const TILE_CACHE = 'public, max-age=3600, s-maxage=86400';

export interface TileImage {
  bytes: Buffer;
  contentType: string;
  cache: string;
}

/** `owner/repo` → 两段；任一段不符合 GitHub 命名形态返回 null。 */
export function parseRepo(repo: string): { owner: string; name: string } | null {
  const [owner = '', name = ''] = repo.trim().split('/');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(name)) return null;
  return { owner, name };
}

/**
 * 解析一张缩略图。`repo` 非法时返回 null（调用方回 400）；
 * 其余任何情况都返回一张图——宁可语言色块，也不要微信里的灰头像。
 */
export async function resolveTileImage(
  repo: string,
  language: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<TileImage | null> {
  const parsed = parseRepo(repo);
  if (parsed === null) return null;

  const upstream = `https://github.com/${encodeURIComponent(parsed.owner)}.png?size=200`;
  try {
    const response = await fetchImpl(upstream, {
      redirect: 'follow',
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.startsWith('image/')) {
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType,
        cache: AVATAR_CACHE,
      };
    }
  } catch {
    // 超时/网络错误：走语言色块。
  }

  return {
    bytes: Buffer.from(tileBase64(language), 'base64'),
    contentType: 'image/png',
    cache: TILE_CACHE,
  };
}
