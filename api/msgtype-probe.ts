import { eq } from 'drizzle-orm';
import { buildDigestNewsFromSnapshot, siteBaseUrl } from '../src/agent/digest.js';
import { getDailySnapshot } from '../src/agent/digest-snapshot.js';
import { db } from '../src/db/client.js';
import { subscribers } from '../src/db/schema.js';
import { env } from '../src/config.js';
import { sendWeComNews } from '../src/wecom/api.js';

/**
 * 【临时预览端点，测完即删】把**生产同一套** news 渲染结果发给指定用户，
 * 用于在真正替换每日简报之前，用肉眼确认卡片观感。
 *
 * 两个用途：
 * - `?tile=1&repo=owner/name&lang=Rust` → 返回缩略图（头像或语言色块）；
 *   预览期间 `/api/tile` 还没部署（Hobby 每部署上限 12 个函数），
 *   所以卡片里的图片临时指向本端点，取图逻辑与生产共用 tile-image。
 * - `?u=<userid>` → 读当日快照 + 该用户偏好，构建 news 卡片并发送。
 *   **不做** pushDigests 的 accept 过滤（已收藏/近期推过/增长门槛），
 *   只用于看版式；真实推送仍走 cron-push-digest。
 *
 * 鉴权复用 CRON_SECRET（`?secret=` 或 `Authorization: Bearer`）。
 */

export const maxDuration = 300;

interface ProbeRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

interface ProbeResponse {
  status(code: number): ProbeResponse;
  setHeader(name: string, value: string): ProbeResponse | void;
  send(body: string | Buffer): unknown;
}

function queryParam(req: ProbeRequest, name: string): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function bearerToken(req: ProbeRequest): string {
  const raw = req.headers?.['authorization'];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
}

function sendJson(res: ProbeResponse, status: number, body: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body, null, 2));
}

export default async function handler(
  req: ProbeRequest,
  res: ProbeResponse,
): Promise<void> {
  const expected = env.CRON_SECRET ?? '';
  const provided = queryParam(req, 'secret') || bearerToken(req);
  if (expected === '' || provided !== expected) {
    res.status(401).send('unauthorized');
    return;
  }

  const userid = queryParam(req, 'u').trim();
  if (userid === '') {
    sendJson(res, 400, { error: 'missing ?u=<wecom userid>' });
    return;
  }

  const baseUrl = siteBaseUrl();
  if (baseUrl === null) {
    sendJson(res, 500, { error: 'site base url unavailable' });
    return;
  }

  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, userid));
  const sub = rows[0];
  if (sub === undefined) {
    sendJson(res, 404, { error: 'subscriber not found' });
    return;
  }

  const snapshot = await getDailySnapshot();
  if (snapshot === null) {
    sendJson(res, 503, { error: 'snapshot unavailable' });
    return;
  }

  const { articles, entries } = await buildDigestNewsFromSnapshot(
    { preferences: sub.preferences },
    snapshot,
    { baseUrl },
  );

  // 服务端预热：确认静态色块可访问。微信是**打开会话时**才去抓图，
  // 只有静态 CDN 才能保证秒开；这里顺便把状态码回给调用方排查。
  const warm = await Promise.all(
    articles.slice(1).map(async (article) => {
      try {
        const response = await fetch(article.picurl, {
          signal: AbortSignal.timeout(5000),
        });
        return {
          url: article.picurl,
          status: response.status,
          type: response.headers.get('content-type'),
        };
      } catch (err) {
        return {
          url: article.picurl,
          status: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  await sendWeComNews(userid, articles);

  sendJson(res, 200, {
    userid,
    date: snapshot.date,
    sent: articles.length,
    entries,
    warm,
    titles: articles.map((article) => ({
      title: article.title,
      bytes: Buffer.byteLength(article.title, 'utf8'),
      picurl: article.picurl,
    })),
  });
}
