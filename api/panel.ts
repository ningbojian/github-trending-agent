import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { normalizePreferences, PUSH_TIME_RE } from '../src/agent/preferences.js';
import { formatSubscriptionSummary } from '../src/agent/subscription-summary.js';
import { mergePreferences } from '../src/agent/subscription-store.js';
import {
  addTrackedRepo,
  listTracked,
  removeTracked,
} from '../src/agent/tracking-service.js';
import { shanghaiToday } from '../src/agent/time.js';
import { db } from '../src/db/client.js';
import { favorites, kvCache, repos, subscribers } from '../src/db/schema.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { readBodyFields } from '../src/http/body.js';
import {
  escapeHtml,
  renderPage,
  sendHtml,
  type HtmlResponse,
} from '../src/http/html.js';
import { getPanelVersion, bumpPanelVersion } from '../src/panel/version.js';
import { signPanelToken, verifyPanelToken } from '../src/panel/token.js';

/**
 * 薄 H5 控制面板：聊天里做不了的事才放这里——跟踪管理、历史简报、
 * 收藏与搜索、订阅设置。入口由机器人按需发签名链接，不追求日活。
 *
 * 所有动态内容都经过 escapeHtml；写操作只接受 POST + 签名 token；
 * token 带版本号，用户在面板里重置后旧链接立即失效。
 */

export interface PanelRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

export type PanelResponse = HtmlResponse;

function queryParam(
  req: PanelRequest,
  name: string,
): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

const INPUT =
  'width:100%;box-sizing:border-box;padding:10px 12px;font-size:16px;border:1px solid #d0d7de;border-radius:8px;';
const BUTTON =
  'display:inline-block;padding:10px 14px;font-size:15px;border:0;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;';
const LINK = 'color:#2563eb;text-decoration:none;';

function card(title: string, body: string): string {
  return `<section style="border:1px solid #d0d7de;border-radius:10px;padding:16px;margin:0 0 14px;">
  <h2 style="font-size:16px;margin:0 0 10px;">${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function nav(token: string, current: string): string {
  const item = (view: string, label: string): string => {
    const active = view === current;
    return `<a href="?t=${encodeURIComponent(token)}&view=${view}" style="margin-right:14px;font-size:14px;${
      active ? 'font-weight:700;color:#1f2328;' : LINK
    }">${escapeHtml(label)}</a>`;
  };
  return `<nav style="margin:0 0 16px;">${item('overview', '总览')}${item('tracking', '跟踪')}${item(
    'history',
    '历史',
  )}${item('favorites', '收藏')}${item('settings', '设置')}</nav>`;
}

function page(title: string, token: string, view: string, body: string): string {
  return renderPage({
    title,
    body: `${nav(token, view)}${body}`,
    subtitle: '控制面板',
  });
}

interface ArchiveItem {
  fullName: string;
  stars: number;
  starsDelta: number;
  summary: string | null;
  url: string;
}

interface Archive {
  date: string;
  message: string | null;
  items: ArchiveItem[];
}

async function readArchives(days: number): Promise<Archive[]> {
  const today = shanghaiToday(new Date());
  const keys = Array.from({ length: days }, (_, index) =>
    `archive:v1:${shiftDate(today, -index)}`,
  );
  const rows = await db()
    .select()
    .from(kvCache)
    .where(inArray(kvCache.key, keys));
  return rows
    .map((row) => row.value as Partial<Archive> | null)
    .filter((value): value is Archive => Boolean(value) && typeof value?.date === 'string')
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function renderOverview(userid: string, token: string): Promise<string> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, userid));
  const sub = rows[0];
  const summary =
    sub === undefined
      ? '没有找到订阅记录。'
      : formatSubscriptionSummary(sub.preferences, sub.active).replace(/\n/g, '<br>');
  const tracked = await listTracked(userid);
  const archives = await readArchives(1);

  return page(
    '总览',
    token,
    'overview',
    `${card('订阅', `<div style="font-size:14px;line-height:1.8;">${summary}</div>`)}
     ${card(
       '跟踪',
       `<div style="font-size:14px;line-height:1.8;">${tracked.length} 个仓库 · <a style="${LINK}" href="?t=${encodeURIComponent(token)}&view=tracking">管理</a></div>`,
     )}
     ${card(
       '最近简报',
       archives[0]
         ? `<div style="font-size:14px;line-height:1.8;"><a style="${LINK}" href="?t=${encodeURIComponent(token)}&view=history&date=${encodeURIComponent(archives[0].date)}">${escapeHtml(archives[0].date)}</a> · ${archives[0].items.length} 条</div>`
         : '<div style="font-size:14px;color:#57606a;">还没有归档。</div>',
     )}`,
  );
}

async function renderTracking(
  userid: string,
  token: string,
  notice?: string,
): Promise<string> {
  const tracked = await listTracked(userid);
  const noticeHtml = notice
    ? `<div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:#dafbe1;color:#1a7f37;font-size:14px;">${escapeHtml(notice)}</div>`
    : '';
  const rows = tracked.length
    ? tracked
        .map(
          (row) => `<li style="margin:0 0 8px;font-size:14px;">
        <a style="${LINK}" href="https://github.com/${escapeHtml(row.identifier)}">${escapeHtml(row.displayName)}</a>
        <form method="post" action="?t=${encodeURIComponent(token)}&view=tracking" style="display:inline;margin-left:8px;">
          <input type="hidden" name="action" value="untrack">
          <input type="hidden" name="identifier" value="${escapeHtml(row.identifier)}">
          <button type="submit" style="border:0;background:none;color:#cf222e;font-size:13px;cursor:pointer;">取消</button>
        </form>
      </li>`,
        )
        .join('')
    : '<div style="font-size:14px;color:#57606a;">还没有跟踪任何仓库。</div>';

  return page(
    '跟踪管理',
    token,
    'tracking',
    `${noticeHtml}
     ${card('正在跟踪', `<ul style="padding-left:20px;margin:0;">${rows}</ul>`)}
     ${card(
       '添加仓库',
       `<form method="post" action="?t=${encodeURIComponent(token)}&view=tracking">
          <input name="action" type="hidden" value="track">
          <input name="repo" placeholder="owner/repo 或 GitHub 链接" style="${INPUT}" required>
          <button type="submit" style="${BUTTON}margin-top:10px;">添加</button>
        </form>
        <div style="font-size:12px;color:#57606a;margin-top:8px;">最多 10 个；每天只报新 release、star 加速或归档。</div>`,
     )}`,
  );
}

function renderArchiveDetail(archive: Archive, token: string): string {
  const items = archive.items
    .map(
      (item, index) =>
        `<li style="margin:0 0 8px;font-size:14px;line-height:1.6;">${index + 1}. <a style="${LINK}" href="${escapeHtml(item.url)}">${escapeHtml(item.fullName)}</a> ★${item.stars} (+${item.starsDelta})${item.summary ? ` — ${escapeHtml(item.summary)}` : ''}</li>`,
    )
    .join('');
  return `<div style="font-size:14px;white-space:pre-wrap;line-height:1.7;margin:0 0 14px;">${escapeHtml(archive.message ?? '当天没有观察。')}</div>
    <ul style="padding-left:20px;margin:0;">${items}</ul>`;
}

async function renderHistory(
  userid: string,
  token: string,
  date: string,
): Promise<string> {
  void userid;
  const archives = await readArchives(14);
  if (date !== '') {
    const archive = archives.find((item) => item.date === date);
    if (archive === undefined) {
      return page('历史简报', token, 'history', card('没有这一天的归档', ''));
    }
    return page(
      '历史简报',
      token,
      'history',
      `${card(
        archive.date,
        `${renderArchiveDetail(archive, token)}<p><a style="${LINK}" href="?t=${encodeURIComponent(token)}&view=history">← 返回列表</a></p>`,
      )}`,
    );
  }

  const list = archives.length
    ? archives
        .map(
          (archive) =>
            `<li style="margin:0 0 8px;font-size:14px;"><a style="${LINK}" href="?t=${encodeURIComponent(token)}&view=history&date=${encodeURIComponent(archive.date)}">${escapeHtml(archive.date)}</a> · ${archive.items.length} 条 · ${archive.message ? '有观察' : '无观察'}</li>`,
        )
        .join('')
    : '<div style="font-size:14px;color:#57606a;">还没有历史归档（从 2026-10-29 起积累）。</div>';
  return page('历史简报', token, 'history', card('最近 14 天', `<ul style="padding-left:20px;margin:0;">${list}</ul>`));
}

async function renderFavorites(
  userid: string,
  token: string,
  query: string,
): Promise<string> {
  const favRows = await db()
    .select()
    .from(favorites)
    .where(eq(favorites.wecomUserid, userid));
  const favList = favRows.length
    ? favRows
        .map(
          (row) =>
            `<li style="margin:0 0 6px;font-size:14px;"><a style="${LINK}" href="https://github.com/${escapeHtml(row.fullName)}">${escapeHtml(row.fullName)}</a></li>`,
        )
        .join('')
    : '<div style="font-size:14px;color:#57606a;">还没有收藏。</div>';

  let searchHtml = '';
  if (query.trim() !== '') {
    const pattern = `%${query.trim()}%`;
    const results = await db()
      .select({
        fullName: repos.fullName,
        description: repos.description,
        stars: repos.stars,
      })
      .from(repos)
      .where(or(ilike(repos.fullName, pattern), ilike(repos.description, pattern)))
      .orderBy(desc(repos.stars))
      .limit(10);
    searchHtml = results.length
      ? `<ul style="padding-left:20px;margin:10px 0 0;">${results
          .map(
            (row) =>
              `<li style="margin:0 0 6px;font-size:14px;"><a style="${LINK}" href="https://github.com/${escapeHtml(row.fullName)}">${escapeHtml(row.fullName)}</a> ★${row.stars}${row.description ? ` — ${escapeHtml(row.description.slice(0, 80))}` : ''}</li>`,
          )
          .join('')}</ul>`
      : '<div style="font-size:14px;color:#57606a;margin-top:10px;">没有找到。</div>';
  }

  return page(
    '收藏与搜索',
    token,
    'favorites',
    `${card('我的收藏', `<ul style="padding-left:20px;margin:0;">${favList}</ul>`)}
     ${card(
       '搜索仓库',
       `<form method="get" action="">
          <input type="hidden" name="t" value="${escapeHtml(token)}">
          <input type="hidden" name="view" value="favorites">
          <input name="q" value="${escapeHtml(query)}" placeholder="仓库名或关键词" style="${INPUT}">
          <button type="submit" style="${BUTTON}margin-top:10px;">搜索</button>
        </form>${searchHtml}`,
     )}`,
  );
}

async function renderSettings(
  userid: string,
  token: string,
  notice?: string,
  error?: string,
): Promise<string> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, userid));
  const prefs = normalizePreferences(rows[0]?.preferences ?? {});
  const languages = Array.isArray((rows[0]?.preferences as { languages?: unknown })?.languages)
    ? ((rows[0]?.preferences as { languages: string[] }).languages.join(', '))
    : '';
  const keywords = Array.isArray((rows[0]?.preferences as { keywords?: unknown })?.keywords)
    ? ((rows[0]?.preferences as { keywords: string[] }).keywords.join(', '))
    : '';
  const banner = error
    ? `<div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:#ffebe9;color:#cf222e;font-size:14px;">${escapeHtml(error)}</div>`
    : notice
      ? `<div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:#dafbe1;color:#1a7f37;font-size:14px;">${escapeHtml(notice)}</div>`
      : '';

  return page(
    '订阅设置',
    token,
    'settings',
    `${banner}
     <form method="post" action="?t=${encodeURIComponent(token)}&view=settings">
      ${card(
        '推送',
        `<label style="font-size:14px;display:block;margin-bottom:6px;">推送时间（北京时间 HH:MM）</label>
         <input name="pushTime" value="${escapeHtml(prefs.pushTime)}" style="${INPUT}" placeholder="09:00">
         <label style="font-size:14px;display:block;margin:12px 0 6px;">每次条数（1–8）</label>
         <input name="digestCount" value="${String(prefs.digestCount)}" style="${INPUT}" inputmode="numeric">
         <label style="font-size:14px;display:block;margin:12px 0 6px;">推送间隔（1–30 天）</label>
         <input name="intervalDays" value="${String(prefs.intervalDays)}" style="${INPUT}" inputmode="numeric">`,
      )}
      ${card(
        '偏好',
        `<label style="font-size:14px;display:block;margin-bottom:6px;">语言（逗号分隔，留空为全部）</label>
         <input name="languages" value="${escapeHtml(languages)}" style="${INPUT}" placeholder="python, rust">
         <label style="font-size:14px;display:block;margin:12px 0 6px;">关键词（逗号分隔，留空为不限制）</label>
         <input name="keywords" value="${escapeHtml(keywords)}" style="${INPUT}" placeholder="ai, agent">`,
      )}
      <button type="submit" style="${BUTTON}">保存</button>
     </form>
     <form method="post" action="?t=${encodeURIComponent(token)}&view=settings" style="margin-top:12px;">
      <input type="hidden" name="action" value="reset">
      <button type="submit" style="border:0;background:none;color:#cf222e;font-size:13px;cursor:pointer;">重置面板链接（旧链接立即失效）</button>
     </form>`,
  );
}

function splitList(value: string): string[] {
  return value
    .split(/[,，、\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export default async function handler(
  req: PanelRequest,
  res: PanelResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendHtml(res, 405, page('方法不支持', '', 'overview', card('只支持 GET / POST', '')));
    return;
  }

  const token = queryParam(req, 't');
  const parsed = verifyPanelToken(token);
  if (parsed === null) {
    sendHtml(res, 401, page('链接无效', '', 'overview', card('请回微信发「我的面板」获取新链接', '')));
    return;
  }
  const currentVersion = await getPanelVersion(parsed.userid);
  if (currentVersion !== parsed.version) {
    sendHtml(res, 401, page('链接已失效', '', 'overview', card('链接已被重置，请回微信发「我的面板」', '')));
    return;
  }

  const userid = parsed.userid;
  const view = queryParam(req, 'view') || 'overview';
  const fields = method === 'POST' ? readBodyFields(req.body) : {};
  let notice: string | undefined;

  if (method === 'POST' && view === 'tracking') {
    if (fields.action === 'track') {
      const result = await addTrackedRepo(userid, fields.repo ?? '');
      notice = result.ok
        ? `已跟踪 ${result.displayName}（当前 ★${result.stars}）`
        : result.reason === 'usage'
          ? '用法：owner/repo 或 GitHub 链接'
          : result.reason === 'limit'
            ? '最多同时跟踪 10 个仓库'
            : '暂时读不到这个仓库';
    } else if (fields.action === 'untrack') {
      await removeTracked(userid, fields.identifier ?? '');
      notice = '已取消跟踪';
    }
  }

  if (method === 'POST' && view === 'settings') {
    if (fields.action === 'reset') {
      const version = await bumpPanelVersion(userid);
      const newToken = signPanelToken(userid, version);
      const link = `${resolveBaseUrl(req.headers)}/api/panel?t=${encodeURIComponent(newToken)}`;
      sendHtml(
        res,
        200,
        page(
          '链接已重置',
          newToken,
          'overview',
          card('新的面板链接（旧链接已失效）', `<div style="font-size:13px;word-break:break-all;"><a style="${LINK}" href="${escapeHtml(link)}">${escapeHtml(link)}</a></div>`),
        ),
      );
      return;
    }

    const pushTime = (fields.pushTime ?? '').trim();
    const digestCount = Number(fields.digestCount);
    const intervalDays = Number(fields.intervalDays);
    const error =
      !PUSH_TIME_RE.test(pushTime)
        ? '推送时间需为 HH:MM（北京时间），例如 09:00'
        : !Number.isInteger(digestCount) || digestCount < 1 || digestCount > 8
          ? '条数需为 1–8 的整数'
          : !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 30
            ? '间隔需为 1–30 的整数'
            : null;
    if (error !== null) {
      sendHtml(res, 400, await renderSettings(userid, token, undefined, error));
      return;
    }
    await mergePreferences(userid, {
      pushTime,
      digestCount,
      intervalDays,
      languages: splitList(fields.languages ?? ''),
      keywords: splitList(fields.keywords ?? ''),
    });
    notice = '已保存';
  }

  if (view === 'tracking') {
    sendHtml(res, 200, await renderTracking(userid, token, notice));
    return;
  }
  if (view === 'history') {
    sendHtml(res, 200, await renderHistory(userid, token, queryParam(req, 'date')));
    return;
  }
  if (view === 'favorites') {
    sendHtml(res, 200, await renderFavorites(userid, token, queryParam(req, 'q')));
    return;
  }
  if (view === 'settings') {
    sendHtml(res, 200, await renderSettings(userid, token, notice));
    return;
  }
  sendHtml(res, 200, await renderOverview(userid, token));
}
