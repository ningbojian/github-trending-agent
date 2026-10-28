import { env } from './config.js';

/**
 * 仓库头像代理：`GET /api/avatar?repo=owner/repo` → 所有者头像（PNG/JPEG）。
 *
 * 为什么要代理：企微在个人微信里显示 news 缩略图时，是**它自己的服务器**去抓
 * `picurl`。实测让它直连 `avatars.githubusercontent.com` 时，同一批 8 张里经常
 * 有若干张取不到，微信端显示 GitHub 的灰色默认头像——而我们本地逐个请求全是
 * 200。也就是说问题在「企微抓第三方图床」这一跳，不在地址。
 *
 * 换成我们自己的域名 + 长缓存后：第一次由函数取图并回源，之后 CDN 直接给，
 * 企微看到的是同域、稳定、有 Cache-Control 的图片。
 *
 * 只允许 GitHub 用户名形态的 owner，上游主机写死 github.com —— 不做通用代理，
 * 避免变成可被利用的 SSRF 跳板。
 */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** GitHub 头像最长缓存一周；头像换得不频繁，换域名/换图后 7 天内自愈。 */
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

interface AvatarRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
}

interface AvatarResponse {
  status(code: number): AvatarResponse;
  setHeader(name: string, value: string): AvatarResponse | void;
  send(body: string | Buffer): unknown;
}

function queryParam(req: AvatarRequest, name: string): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function handler(
  req: AvatarRequest,
  res: AvatarResponse,
): Promise<void> {
  const repo = queryParam(req, 'repo').trim();
  const owner = repo.split('/')[0] ?? '';
  if (!OWNER_RE.test(owner)) {
    res.status(400).send('bad repo');
    return;
  }

  // `github.com/<owner>.png` 会 302 到 avatars.githubusercontent.com，
  // 由服务端跟随重定向，客户端只看到我们这一次跳转、一个稳定 URL。
  const upstream = `https://github.com/${encodeURIComponent(owner)}.png?size=200`;
  try {
    const response = await fetch(upstream, { redirect: 'follow' });
    if (!response.ok) {
      res.status(502).send('avatar unavailable');
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    res.setHeader('content-type', response.headers.get('content-type') ?? 'image/png');
    res.setHeader('cache-control', CACHE_CONTROL);
    res.status(200).send(bytes);
  } catch (err) {
    console.warn('[avatar] fetch failed:', err instanceof Error ? err.message : err);
    res.status(502).send('avatar unavailable');
  }
}
