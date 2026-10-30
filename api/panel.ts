import { desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { normalizePreferences, PUSH_TIME_RE } from '../src/agent/preferences.js';
import {
  forgetAll,
  forgetFacts,
  PROFILE_MAX_FACT_CHARS,
  PROFILE_MAX_FACTS,
  readProfile,
  rememberFact,
} from '../src/agent/profile.js';
import { signSetKeyToken } from '../src/agent/setkey-token.js';
import { mergePreferences } from '../src/agent/subscription-store.js';
import { shanghaiToday } from '../src/agent/time.js';
import {
  addTrackedRepo,
  listTracked,
  removeTracked,
} from '../src/agent/tracking-service.js';
import { readWeekStats, type WeeklyStats } from '../src/agent/weekly-review.js';
import { db } from '../src/db/client.js';
import { favorites, kvCache, repos, subscribers, trendingEntries } from '../src/db/schema.js';
import { resolveBaseUrl } from '../src/email/tokens.js';
import { parseRepoRef } from '../src/github/repo-ref.js';
import {
  favoriteRepo,
  loadBindingAuth,
  unfavoriteRepo,
  clearGithubBinding,
  importGithubStars,
  type BindingAuth,
} from '../src/github/stars.js';
import { readDailySnapshotCache, type DigestSnapshotItem } from '../src/agent/digest-snapshot.js';
import { clearUserLlm } from '../src/agent/user-llm.js';
import { buildAuthorizeUrl } from '../src/github/oauth.js';
import { readBodyFields } from '../src/http/body.js';
import {
  escapeHtml,
  renderPage,
  sendHtml,
  type HtmlResponse,
} from '../src/http/html.js';
import {
  PANEL_CARD_BG,
  PANEL_CARD_BORDER,
  PANEL_PAGE_BG,
  PANEL_STYLES,
} from '../src/panel/styles.js';
import { POINTER_SCRIPT } from '../src/ui/pointer.js';
import { APP_FOOTER, APP_TEXT } from '../src/ui/tokens.js';
import { renderRobotMascot, ROBOT_ATTRIBUTION, ROBOT_SCRIPT, type RobotMood, type RobotProp } from '../src/panel/robot.js';
import {
  bumpPanelDirty,
  readPanelDirty,
  readPanelHtml,
  writePanelHtml,
} from '../src/panel/cache.js';
import { weatherForPanel } from '../src/panel/weather.js';
import { AUTO_CITY, cityBySlug, WEATHER_CITIES } from '../src/weather/cities.js';
import type { Weather } from '../src/weather/service.js';
import { bumpPanelVersion, getPanelVersion } from '../src/panel/version.js';
import { signPanelToken, verifyPanelToken } from '../src/panel/token.js';

/**
 * H5 控制面板：聊天里做不了、做起来别扭的事才放这里——订阅暂停/恢复、
 * 跟踪管理、历史简报、收藏与搜索、记忆增删、模型入口。
 *
 * 数据纪律：所有写操作与聊天命令共用同一套服务层（mergePreferences、
 * tracking-service、stars 的 favoriteRepo/unfavoriteRepo、profile 的
 * rememberFact/forgetFacts），面板只是换了个输入方式，不另写一套业务规则。
 *
 * 安全：所有动态内容经 escapeHtml；写操作只接受 POST + 签名 token；
 * token 带版本号，重置后旧链接立即失效。
 */

export interface PanelRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

export type PanelResponse = HtmlResponse;

function queryParam(req: PanelRequest, name: string): string {
  const value = req.query?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** 站内链接：统一走 URLSearchParams，token 与 view 不会把 `&` 拼错。 */
function href(token: string, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams();
  if (token !== '') qs.set('t', token);
  for (const [key, value] of Object.entries(params)) qs.set(key, value);
  return `?${qs.toString()}`;
}

/** 带路径的站内链接：GitHub 授权回调要用绝对路径才能跳回面板。 */
function panelPath(token: string, params: Record<string, string> = {}): string {
  return `/api/panel${href(token, params)}`;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

const NAV_ITEMS: Array<{ view: string; label: string }> = [
  { view: 'overview', label: '总览' },
  { view: 'tracking', label: '跟踪' },
  { view: 'history', label: '历史' },
  { view: 'favorites', label: '收藏' },
  { view: 'memory', label: '记忆' },
  { view: 'settings', label: '设置' },
];

function nav(token: string, current: string): string {
  const items = NAV_ITEMS.map(
    (item) =>
      `<a href="${href(token, { view: item.view })}"${
        item.view === current ? ' aria-current="page"' : ''
      }>${escapeHtml(item.label)}</a>`,
  ).join('');
  return `<nav class="panel-nav" aria-label="面板导航">${items}</nav>`;
}

function card(title: string, body: string): string {
  return `<section class="p-card"><h2 class="p-card-title">${escapeHtml(title)}</h2>${body}</section>`;
}

function empty(text: string): string {
  return `<div class="p-empty">${escapeHtml(text)}</div>`;
}

/**
 * 今日洞察：从当日快照缓存里算一句真话（不调模型、不猜）。
 * 没有任何快照时返回空串，机器人气泡退回默认文案。
 */
function dailyInsight(items: DigestSnapshotItem[]): string {
  if (items.length === 0) return '';
  const fresh = items.filter((item) => item.isNew).length;
  const top = [...items].sort((a, b) => b.starsDelta - a.starsDelta)[0];
  const languages = new Map<string, number>();
  for (const item of items) {
    if (item.language) {
      languages.set(item.language, (languages.get(item.language) ?? 0) + 1);
    }
  }
  const topLanguage = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const parts = [
    `今天 ${items.length} 个项目，${fresh} 个新上榜`,
    `涨得最快 ${top.fullName}（+${top.starsDelta}）`,
  ];
  if (topLanguage) parts.push(`主力语言 ${topLanguage}`);
  return parts.join('；');
}

/**
 * 视图头：标题 + 一句状态 + 角落机器人。
 * 除总览（hero 自带机器人）外，每个视图都用它，保证每个功能里都有那张脸。
 */
function viewHead(
  title: string,
  say: string,
  weather: Weather | null,
  mood: RobotMood = 'idle',
  prop: RobotProp | null = null,
  tip = '',
  action?: { href: string; label: string },
): string {
  return `<section class="p-card p-view-head">
    <div class="p-view-head-main">
      <div class="p-hero-label">${escapeHtml(title)}</div>
      <div class="p-view-say">${escapeHtml(say)}</div>
    </div>
    ${renderRobotMascot(weather, new Date(), { mood, prop, say: tip, action })}
  </section>`;
}

function banner(notice?: string, error?: string): string {
  if (error) {
    return `<div class="p-banner err">${escapeHtml(error)}</div>`;
  }
  if (notice) {
    return `<div class="p-banner ok">${escapeHtml(notice)}</div>`;
  }
  return '';
}

function page(title: string, token: string, view: string, body: string): string {
  return renderPage({
    title,
    // 机器人脚本每个视图都要有：没有它，两颗贴纸会堆在同一个中心点上，
    // 既不能拖也没有轨道——除总览外全是「叠起来」的静态版。
    body: `<div class="panel">${nav(token, view)}${body}</div><script>${POINTER_SCRIPT}</script><script>${ROBOT_SCRIPT}</script>`,
    subtitle: '控制面板',
    styles: PANEL_STYLES,
    pageBg: PANEL_PAGE_BG,
    cardBg: PANEL_CARD_BG,
    cardBorder: PANEL_CARD_BORDER,
    textColor: APP_TEXT,
    footerColor: APP_FOOTER,
    cardPadding: '16px',
    headerClass: 'panel-header',
    shellClass: 'panel-shell',
    shellRadius: '20px',
  });
}

function statusBadge(hasRow: boolean, active: boolean): string {
  if (!hasRow) return '<span class="p-badge off">尚未订阅</span>';
  return active
    ? '<span class="p-badge ok">推送中</span>'
    : '<span class="p-badge off">已暂停</span>';
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

async function readSubscriber(userid: string) {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, userid));
  return rows[0];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 订阅天数按北京日历日算；created_at 缺失/坏值时按 0（今天）处理。 */
function subscribedDays(createdAt: unknown, now: Date): number {
  const date = createdAt instanceof Date ? createdAt : new Date(String(createdAt ?? ''));
  if (Number.isNaN(date.getTime())) return 0;
  const start = Date.parse(shanghaiToday(date));
  const today = Date.parse(shanghaiToday(now));
  return Math.max(0, Math.round((today - start) / DAY_MS));
}

/**
 * 本周个人卡：数字全部来自周复盘同一套统计（readWeekStats），
 * 不另算一套；没有数据时只说一句，不摆一排 0。
 */
function personalCard(
  sub: { createdAt?: unknown; preferences?: unknown } | undefined,
  week: WeeklyStats | null,
): string {
  if (sub === undefined) return '';

  const days = subscribedDays(sub.createdAt, new Date());
  const pushed = week?.pushed ?? 0;
  const favorited = week?.favorited ?? 0;
  const liked = week?.liked ?? 0;
  const disliked = week?.disliked ?? 0;
  const more = week?.more ?? [];
  const less = week?.less ?? [];

  if (days === 0 && pushed === 0 && favorited === 0) {
    const pushTime = normalizePreferences(sub.preferences ?? {}).pushTime;
    return card('本周', empty(`今天刚订阅。下一次简报在 ${pushTime}。`));
  }

  let taste: string;
  if (more.length > 0 || less.length > 0) {
    const parts: string[] = [];
    if (more.length > 0) {
      parts.push(`最近更常看 <b>${more.map(escapeHtml).join('、')}</b>`);
    }
    if (less.length > 0) {
      parts.push(`少看 <b>${less.map(escapeHtml).join('、')}</b>`);
    }
    taste = `<div class="p-taste">${parts.join('；')}</div>`;
  } else if (liked + disliked > 0) {
    taste = '<div class="p-taste">口味信号还不多，再回几次「感兴趣 / 不感兴趣」。</div>';
  } else {
    taste =
      '<div class="p-taste">还没有口味信号。在简报上回「感兴趣」或「不感兴趣」，我就知道该多推什么。</div>';
  }

  return card(
    '本周',
    `<div class="p-stats">
      <div class="p-stat"><strong>${pushed}</strong><span>条推送</span></div>
      <div class="p-stat"><strong>${favorited}</strong><span>个收藏</span></div>
      <div class="p-stat"><strong>${days + 1}</strong><span>订阅天数</span></div>
    </div>${taste}`,
  );
}

/** 暂停/恢复的按钮。没有订阅者行时不显示（恢复需要先发「订阅 …」建行）。 */
function subscriptionToggle(
  token: string,
  view: string,
  hasRow: boolean,
  active: boolean,
): string {
  if (!hasRow) return '';
  const action = active ? 'unsubscribe' : 'resubscribe';
  const label = active ? '暂停推送' : '恢复推送';
  const style = active ? 'p-btn ghost' : 'p-btn';
  return `<form method="post" action="${href(token, { view })}">
    <input type="hidden" name="action" value="${action}">
    <button class="${style}" type="submit">${label}</button>
  </form>`;
}

async function renderOverview(
  userid: string,
  token: string,
  weather: Weather | null,
  notice?: string,
  error?: string,
): Promise<string> {
  const sub = await readSubscriber(userid);
  const prefs = normalizePreferences(sub?.preferences ?? {});
  const active = sub?.active ?? false;
  // 四个查询互不依赖：并行跑，别把 DB 往返叠成四个。
  const [tracked, archives, memoryCount, week, snapshot] = await Promise.all([
    listTracked(userid),
    readArchives(1),
    readProfile(userid)
      .then((profile) => profile?.facts.length ?? 0)
      .catch(() => 0),
    readWeekStats(userid).catch((err: unknown) => {
      console.error('panel weekly stats failed:', err);
      return null;
    }),
    readDailySnapshotCache().catch(() => null),
  ]);
  const insightItems = snapshot ? snapshot.items.slice(0, prefs.digestCount) : [];
  const insight = dailyInsight(insightItems);
  const mood: RobotMood = notice ? 'happy' : error ? 'alert' : active ? 'idle' : 'sleepy';

  const cadence =
    prefs.intervalDays > 1
      ? `每 ${prefs.intervalDays} 天 · ${prefs.pushTime}`
      : `每天 ${prefs.pushTime}`;
  const chips = [...prefs.languages, ...prefs.keywords]
    .map((item) => `<span class="p-chip">${escapeHtml(item)}</span>`)
    .join('');

  const hero = `<section class="p-card p-hero-card">
    <div class="p-hero-head">
      <div class="p-hero-time">${escapeHtml(cadence)}</div>
      ${statusBadge(sub !== undefined, active)}
    </div>
    <div class="p-hero-sub">北京时间 · 每次 ${prefs.digestCount} 条</div>
    ${chips ? `<div class="p-chips">${chips}</div>` : ''}
    ${insight ? `<div class="p-taste">💡 ${escapeHtml(insight)}</div>` : ''}
    <div class="p-actions">
      <a class="p-btn" href="${href(token, { view: 'settings' })}">调整设置</a>
      ${subscriptionToggle(token, 'overview', sub !== undefined, active)}
    </div>
    ${renderRobotMascot(weather, new Date(), { mood })}
  </section>`;

  const tiles = `<div class="p-grid">
    <a class="p-tile" href="${href(token, { view: 'tracking' })}">
      <div class="p-tile-num">${tracked.length}</div>
      <div class="p-tile-label">跟踪仓库</div>
      <div class="p-tile-hint">release 与 star 异动</div>
    </a>
    <a class="p-tile" href="${href(token, { view: 'favorites' })}">
      <div class="p-tile-num">★</div>
      <div class="p-tile-label">收藏</div>
      <div class="p-tile-hint">收藏、取消与搜索</div>
    </a>
    <a class="p-tile" href="${href(token, { view: 'history' })}">
      <div class="p-tile-num">${archives[0] ? archives[0].items.length : '—'}</div>
      <div class="p-tile-label">最近简报</div>
      <div class="p-tile-hint">${archives[0] ? escapeHtml(archives[0].date) : '还没有归档'}</div>
    </a>
    <a class="p-tile" href="${href(token, { view: 'memory' })}">
      <div class="p-tile-num">${memoryCount}</div>
      <div class="p-tile-label">记忆</div>
      <div class="p-tile-hint">你的背景与偏好</div>
    </a>
  </div>`;

  return page(
    '总览',
    token,
    'overview',
    `${banner(notice, error)}${hero}${personalCard(sub, week)}${tiles}
     <p class="p-foot">${escapeHtml(ROBOT_ATTRIBUTION)}</p>`,
  );
}

async function renderTracking(
  userid: string,
  token: string,
  weather: Weather | null,
  notice?: string,
  error?: string,
): Promise<string> {
  const tracked = await listTracked(userid);
  const rows = tracked.length
    ? `<ul class="p-list">${tracked
        .map(
          (row) => `<li class="p-row">
        <div class="p-row-main">
          <a href="https://github.com/${escapeHtml(row.identifier)}" target="_blank" rel="noopener">${escapeHtml(row.displayName)}</a>
          <div class="p-row-sub">${escapeHtml(row.identifier)}</div>
        </div>
        <form method="post" action="${href(token, { view: 'tracking' })}">
          <input type="hidden" name="action" value="untrack">
          <input type="hidden" name="identifier" value="${escapeHtml(row.identifier)}">
          <button class="p-btn danger" type="submit">取消</button>
        </form>
      </li>`,
        )
        .join('')}</ul>`
    : empty('还没跟踪任何仓库。加一个 owner/repo，有 release 或 star 加速时我会说一声。');

  return page(
    '跟踪管理',
    token,
    'tracking',
    `${banner(notice, error)}
     ${viewHead(
       '跟踪',
       tracked.length ? `${tracked.length} 个仓库 · 有变化我会说` : '还没跟踪仓库',
       weather,
       error ? 'alert' : notice ? 'happy' : 'idle',
       'search',
       '有 release 或 star 加速时，我会在这里说一声。',
       { href: href(token, { view: 'checkup' }), label: '给跟踪的仓库做体检' },
     )}
     ${card('跟踪中', rows)}
     ${card(
       '加一个',
       `<form method="post" action="${href(token, { view: 'tracking' })}">
          <input type="hidden" name="action" value="track">
          <label class="p-field">
            <span class="p-label">仓库</span>
            <input class="p-input" name="repo" placeholder="owner/repo 或 GitHub 链接" required>
            <span class="p-hint">最多 10 个；每天只报新 release、star 加速或归档。</span>
          </label>
          <button class="p-btn block" type="submit">添加跟踪</button>
        </form>`,
     )}`,
  );
}

function renderArchiveDetail(archive: Archive): string {
  const items = archive.items
    .map(
      (item, index) => `<div class="p-item">
        <div class="p-item-rank">${index + 1}</div>
        <div class="p-item-body">
          <a class="p-item-name" href="${escapeHtml(item.url)}">${escapeHtml(item.fullName)}</a>
          <div class="p-item-meta">★${item.stars} · +${item.starsDelta}</div>
          ${item.summary ? `<div class="p-item-summary">${escapeHtml(item.summary)}</div>` : ''}
        </div>
      </div>`,
    )
    .join('');
  return `<div class="p-prose">${escapeHtml(archive.message ?? '当天没有观察。')}</div>${items}`;
}

async function renderHistory(
  userid: string,
  token: string,
  date: string,
  weather: Weather | null,
): Promise<string> {
  void userid;
  const archives = await readArchives(14);
  if (date !== '') {
    const archive = archives.find((item) => item.date === date);
    if (archive === undefined) {
      return page(
        '历史简报',
        token,
        'history',
        `${card('没有这一天的归档', empty('换一天看看。'))}
         <p><a class="p-btn ghost" href="${href(token, { view: 'history' })}">← 返回列表</a></p>`,
      );
    }
    return page(
      '历史简报',
      token,
      'history',
      `${card(archive.date, renderArchiveDetail(archive))}
       <p><a class="p-btn ghost" href="${href(token, { view: 'history' })}">← 返回列表</a></p>`,
    );
  }

  const list = archives.length
    ? `<ul class="p-list">${archives
        .map(
          (archive) => `<li class="p-row">
          <a class="p-row-main p-row-link" href="${href(token, {
            view: 'history',
            date: archive.date,
          })}">
            <span class="p-row-title">${escapeHtml(archive.date)}</span>
            <span class="p-row-sub">${archive.items.length} 条 · ${archive.message ? '有观察' : '无观察'}</span>
          </a>
          <span class="p-row-arrow" aria-hidden="true">›</span>
        </li>`,
        )
        .join('')}</ul>`
    : empty('还没有归档。推送之后会出现在这里。');

  return page(
    '历史简报',
    token,
    'history',
    `${viewHead(
      '历史简报',
      archives.length ? `已归档 ${archives.length} 天` : '还没有归档',
      weather,
      'idle',
      'calendar',
      '每天 9 点后的简报会归档在这里，保留 14 天。',
      archives[0]
        ? { href: href(token, { view: 'history', date: archives[0].date }), label: '看最近一天的简报' }
        : undefined,
    )}${card('最近 14 天', list)}`,
  );
}

/** 仓库体检：从收藏/跟踪里挑一个仓库，出一屏数据卡（只读库，不调外部 API）。 */
async function renderCheckup(
  userid: string,
  token: string,
  weather: Weather | null,
  index: number,
): Promise<string> {
  const [favRows, tracked] = await Promise.all([
    db()
      .select()
      .from(favorites)
      .where(eq(favorites.wecomUserid, userid))
      .orderBy(desc(favorites.createdAt))
      .limit(5),
    listTracked(userid),
  ]);
  const candidates = [
    ...favRows.map((row) => row.fullName),
    ...tracked.map((row) => row.identifier),
  ];
  const head = (say: string, mood: RobotMood = 'idle', tip = ''): string =>
    viewHead('仓库体检', say, weather, mood, 'search', tip);

  if (candidates.length === 0) {
    return page(
      '仓库体检',
      token,
      'checkup',
      `${head('还没有可体检的仓库', 'alert', '先收藏或跟踪一个仓库，再回来。')}
       ${card('怎么做', empty('收藏或跟踪一个仓库后，这里会给你一张体检卡。'))}`,
    );
  }

  const pick = candidates[Math.abs(index) % candidates.length]!;
  const [repoRows, entryRows] = await Promise.all([
    db().select().from(repos).where(eq(repos.fullName, pick)).limit(1),
    db()
      .select()
      .from(trendingEntries)
      .where(eq(trendingEntries.fullName, pick))
      .orderBy(desc(trendingEntries.date))
      .limit(1),
  ]);
  const repo = repoRows[0];
  const entry = entryRows[0];

  const next = `<div class="p-actions">
    <a class="p-btn ghost" href="${href(token, { view: 'checkup', i: String(index + 1) })}">换一个</a>
    <a class="p-btn ghost" href="${href(token, { view: 'favorites' })}">回收藏</a>
  </div>`;

  if (repo === undefined) {
    return page(
      '仓库体检',
      token,
      'checkup',
      `${head('这个仓库还没入库', 'alert')}
       ${card(pick, empty('刚收藏的仓库可能还没抓取到；明天再看。'))}${next}`,
    );
  }

  const verdict =
    repo.stars >= 50000
      ? '大热门，生态成熟，适合直接采用'
      : repo.stars >= 10000
        ? '成熟项目，社区活跃，可以放心依赖'
        : repo.stars >= 1000
          ? '稳步成长，值得关注，注意维护频率'
          : '早期项目，采用前先看提交活跃度';
  const trend = entry
    ? `最近一次在榜 ${entry.date}，+${entry.starsDelta} 星${entry.isNew ? '（新上榜）' : ''}`
    : '最近没有上榜记录';

  const body = `<div class="p-kv">
    <div><dt>仓库</dt><dd>${escapeHtml(repo.fullName)}</dd></div>
    <div><dt>语言</dt><dd>${escapeHtml(repo.language ?? '未知')}</dd></div>
    <div><dt>星标</dt><dd>${escapeHtml(String(repo.stars))}</dd></div>
    <div><dt>榜单</dt><dd>${escapeHtml(trend)}</dd></div>
    <div><dt>结论</dt><dd>${escapeHtml(verdict)}</dd></div>
  </div>`;

  return page(
    '仓库体检',
    token,
    'checkup',
    `${head(verdict, 'happy', '这是从你收藏/跟踪里挑的一个仓库。')}
     ${card(pick, body)}${next}`,
  );
}

/** 收藏写失败时的统一中文文案（与聊天命令同一套语义）。 */
function favoriteError(kind: 'unbound' | 'expired'): string {
  return kind === 'unbound'
    ? '还没绑定 GitHub。点上面的「绑定 GitHub」授权一次即可。'
    : 'GitHub 授权已过期，点上面的「重新绑定」即可。';
}

/**
 * GitHub 绑定卡：面板里直接发起授权，不再要求用户回微信发「绑定」。
 * 只在未绑定/失效时生成一次性链接（写一条 10 分钟的 state）；已绑定只显示账号。
 */
async function githubBindingCard(
  userid: string,
  token: string,
  auth: BindingAuth,
): Promise<string> {
  if (auth.kind === 'ok') {
    return card(
      'GitHub 账号',
      `<div class="p-row-sub p-mb">已绑定 ${escapeHtml(auth.login ?? '（已授权）')}</div>
       <div class="p-actions">
         <form method="post" action="${href(token, { view: 'favorites' })}">
           <input type="hidden" name="action" value="sync-stars">
           <button class="p-btn ghost sm" type="submit">从 GitHub 同步收藏</button>
         </form>
         <form method="post" action="${href(token, { view: 'settings' })}">
           <input type="hidden" name="action" value="unbind-github">
           <button class="p-btn danger" type="submit">解除绑定</button>
         </form>
       </div>`,
    );
  }
  const label = auth.kind === 'unbound' ? '绑定 GitHub' : '重新绑定';
  const hint =
    auth.kind === 'unbound'
      ? '绑定后可以在面板里直接收藏，并同步到你的 GitHub star。'
      : 'GitHub 授权已过期，重新绑定即可恢复收藏。';
  try {
    const url = await buildAuthorizeUrl(userid, {
      returnPath: panelPath(token, { view: 'favorites' }),
    });
    return card(
      'GitHub 账号',
      `<div class="p-row-sub p-mb">${hint}</div>
       <a class="p-btn" href="${escapeHtml(url)}">${label}</a>`,
    );
  } catch (err) {
    // 授权链接生成失败（缺 GITHUB_CLIENT_ID、DB 异常）不该让整页 500。
    console.error('panel bind url failed:', err);
    return card(
      'GitHub 账号',
      `<div class="p-row-sub">${hint}暂时无法生成授权链接，请回微信发「绑定」。</div>`,
    );
  }
}

async function applyFavoriteAction(
  userid: string,
  action: 'favorite' | 'unfavorite',
  rawFullName: string,
): Promise<{ notice?: string; error?: string }> {
  const ref = parseRepoRef(rawFullName);
  if (ref === null) {
    return { error: '这个仓库名不对，应该是 owner/repo。' };
  }
  const fullName = `${ref.owner}/${ref.name}`;
  const auth = await loadBindingAuth(userid);
  if (auth.kind !== 'ok') {
    return { error: favoriteError(auth.kind) };
  }

  if (action === 'favorite') {
    const result = await favoriteRepo(userid, auth.token, fullName);
    if (result === 'auth_failed') {
      return { error: favoriteError('expired') };
    }
    if (result === 'sync_failed') {
      return { notice: `记下了：${fullName}。GitHub 没同步上，以后不会再推它。` };
    }
    return { notice: `收好了：${fullName}。GitHub 上也 star 了。` };
  }

  const result = await unfavoriteRepo(userid, auth.token, fullName);
  if (result === 'auth_failed') {
    return { error: favoriteError('expired') };
  }
  if (result === 'failed') {
    return { error: '没取消成功，稍后再试。' };
  }
  return { notice: `取消了：${fullName}。GitHub 上的 star 也撤了。` };
}

async function renderFavorites(
  userid: string,
  token: string,
  query: string,
  weather: Weather | null,
  notice?: string,
  error?: string,
): Promise<string> {
  const [favRows, binding] = await Promise.all([
    db()
      .select()
      .from(favorites)
      .where(eq(favorites.wecomUserid, userid)),
    loadBindingAuth(userid),
  ]);
  // 新收藏的排前面；createdAt 可能是 Date（PG timestamp 序列化）。
  const sorted = [...favRows].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const owned = new Set(sorted.map((row) => row.fullName.toLowerCase()));
  // 未绑定 GitHub 时收藏写不进来：机器人举牌子提示，而不是等用户点「取消」才发现。
  const mood: RobotMood = error
    ? 'alert'
    : notice
      ? 'happy'
      : binding.kind === 'ok'
        ? 'idle'
        : 'alert';

  const favList = sorted.length
    ? `<ul class="p-list">${sorted
        .map(
          (row) => `<li class="p-row">
          <div class="p-row-main">
            <a href="https://github.com/${escapeHtml(row.fullName)}" target="_blank" rel="noopener">${escapeHtml(row.fullName)}</a>
            <div class="p-row-sub">${row.starredOnGithub ? '已同步到 GitHub' : '仅本地收藏'}</div>
          </div>
          <form method="post" action="${href(token, { view: 'favorites' })}">
            <input type="hidden" name="action" value="unfavorite">
            <input type="hidden" name="fullName" value="${escapeHtml(row.fullName)}">
            <button class="p-btn danger" type="submit">取消</button>
          </form>
        </li>`,
        )
        .join('')}</ul>`
    : empty('这里还空着。搜一个仓库，点「收藏」；或者在简报里回「收藏 1」。');

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
    // 收藏后回到同一个搜索页，而不是把用户刚搜的结果清掉。
    const favoriteAction = href(token, {
      view: 'favorites',
      q: query,
    });
    searchHtml = results.length
      ? `<ul class="p-list">${results
          .map((row) => {
            const action = owned.has(row.fullName.toLowerCase())
              ? '<span class="p-badge ok">已收藏</span>'
              : `<form method="post" action="${favoriteAction}">
                  <input type="hidden" name="action" value="favorite">
                  <input type="hidden" name="fullName" value="${escapeHtml(row.fullName)}">
                  <button class="p-btn ghost sm" type="submit">收藏</button>
                </form>`;
            return `<li class="p-row">
              <div class="p-row-main">
                <a href="https://github.com/${escapeHtml(row.fullName)}" target="_blank" rel="noopener">${escapeHtml(row.fullName)}</a>
                <div class="p-row-sub">★${row.stars}${row.description ? ` · ${escapeHtml(row.description.slice(0, 70))}` : ''}</div>
              </div>
              ${action}
            </li>`;
          })
          .join('')}</ul>`
      : empty('没搜到。换个仓库名或关键词试试。');
  }

  return page(
    '收藏与搜索',
    token,
    'favorites',
    `${banner(notice, error)}
     ${viewHead(
       '收藏与搜索',
       binding.kind === 'ok' ? `${sorted.length} 个收藏` : '还没绑定 GitHub',
       weather,
       mood,
       'star',
       binding.kind === 'ok'
         ? '点「收藏」会同时 star 到你的 GitHub。'
         : '先绑定 GitHub，我才能帮你收藏。',
       { href: href(token, { view: 'checkup' }), label: '给一个仓库做体检' },
     )}
     ${await githubBindingCard(userid, token, binding)}
     ${card('我的收藏', favList)}
     <div class="p-actions">
       <a class="p-btn ghost" href="${href(token, { view: 'checkup' })}">给一个仓库做体检</a>
     </div>
     ${card(
       '搜一个仓库',
       `<form method="get" action="">
          <input type="hidden" name="t" value="${escapeHtml(token)}">
          <input type="hidden" name="view" value="favorites">
          <input class="p-input" name="q" value="${escapeHtml(query)}" placeholder="仓库名或关键词">
          <button class="p-btn block p-mt" type="submit">搜索</button>
        </form>
        ${searchHtml}`,
     )}`,
  );
}

async function renderMemory(
  userid: string,
  token: string,
  weather: Weather | null,
  notice?: string,
  error?: string,
): Promise<string> {
  const profile = await readProfile(userid);
  const facts = profile?.facts ?? [];
  const list = facts.length
    ? `<ul class="p-list">${facts
        .map(
          (fact, index) => `<li class="p-row">
          <span class="p-row-num">${index + 1}</span>
          <div class="p-row-main">${escapeHtml(fact)}</div>
          <form method="post" action="${href(token, { view: 'memory' })}">
            <input type="hidden" name="action" value="forget">
            <input type="hidden" name="term" value="${escapeHtml(fact)}">
            <button class="p-btn danger" type="submit">删除</button>
          </form>
        </li>`,
        )
        .join('')}</ul>`
    : empty('还没写过记忆。写一句你在做什么，我回答时会照着你的语境来。');

  return page(
    '我的记忆',
    token,
    'memory',
    `${banner(notice, error)}
     ${viewHead(
       '我的记忆',
       facts.length ? `${facts.length} 条记忆` : '还没记下任何背景',
       weather,
       error ? 'alert' : notice ? 'happy' : 'idle',
       'note',
       '这些背景只用来改进措辞，不会决定推什么。',
     )}
     ${card(`我的记忆（${facts.length}/${PROFILE_MAX_FACTS}）`, list)}
     ${card(
       '记一句',
       `<form method="post" action="${href(token, { view: 'memory' })}">
          <input type="hidden" name="action" value="remember">
          <label class="p-field">
            <span class="p-label">一句话背景</span>
            <input class="p-input" name="fact" placeholder="例如：我主要做 Agent 开发" required>
            <span class="p-hint">最多 ${PROFILE_MAX_FACTS} 条，每条 ${PROFILE_MAX_FACT_CHARS} 字；180 天未使用自动过期。</span>
          </label>
          <button class="p-btn block" type="submit">记住</button>
        </form>`,
     )}
     ${
       facts.length > 0
         ? card(
             '清空',
             `<form method="post" action="${href(token, { view: 'memory' })}">
                <input type="hidden" name="action" value="forget-all">
                <button class="p-btn danger" type="submit">清空全部记忆</button>
              </form>`,
           )
         : ''
     }`,
  );
}

/** 模型入口：一次点击进 set-key 表单页（15 分钟一次性 token）。 */
function modelEntryLink(userid: string): string {
  return `/api/set-key?t=${encodeURIComponent(signSetKeyToken(userid))}`;
}

async function renderSettings(
  userid: string,
  token: string,
  weather: Weather | null,
  notice?: string,
  error?: string,
): Promise<string> {
  const [sub, binding] = await Promise.all([
    readSubscriber(userid),
    loadBindingAuth(userid),
  ]);
  const llmModel = (sub as { llmModel?: string | null } | undefined)?.llmModel ?? null;
  const prefs = normalizePreferences(sub?.preferences ?? {});
  const languages = Array.isArray((sub?.preferences as { languages?: unknown })?.languages)
    ? (sub?.preferences as { languages: string[] }).languages.join(', ')
    : '';
  const keywords = Array.isArray((sub?.preferences as { keywords?: unknown })?.keywords)
    ? (sub?.preferences as { keywords: string[] }).keywords.join(', ')
    : '';
  const active = sub?.active ?? false;
  const rawWeatherCity = (
    sub?.preferences as { weatherCity?: unknown } | undefined
  )?.weatherCity;
  const weatherCity =
    typeof rawWeatherCity === 'string' ? rawWeatherCity : AUTO_CITY;
  const cityOptions = [
    `<option value="${AUTO_CITY}"${weatherCity === AUTO_CITY ? ' selected' : ''}>自动（按网络位置）</option>`,
    ...WEATHER_CITIES.map(
      (city) =>
        `<option value="${city.slug}"${weatherCity === city.slug ? ' selected' : ''}>${escapeHtml(city.name)}</option>`,
    ),
  ].join('');

  const status = `<div class="p-hero-top">
      <div>
        <div class="p-hero-label">推送状态</div>
        <div class="p-hero-time sm">${escapeHtml(prefs.pushTime)} · ${
          prefs.intervalDays > 1 ? `每 ${prefs.intervalDays} 天` : '每天'
        }</div>
        <div class="p-hero-sub">北京时间 · 每次 ${prefs.digestCount} 条</div>
      </div>
      ${statusBadge(sub !== undefined, active)}
    </div>
    <div class="p-actions">${subscriptionToggle(token, 'settings', sub !== undefined, active)}</div>`;

  return page(
    '订阅设置',
    token,
    'settings',
    `${banner(notice, error)}
     ${viewHead(
       '订阅设置',
       `${prefs.pushTime} · ${prefs.intervalDays > 1 ? `每 ${prefs.intervalDays} 天` : '每天'} · ${prefs.digestCount} 条`,
       weather,
       error ? 'alert' : notice ? 'happy' : 'idle',
       'gear',
       '改完记得点「保存设置」。',
     )}
     ${card('状态', status)}
     ${await githubBindingCard(userid, token, binding)}
     <form method="post" action="${href(token, { view: 'settings' })}">
      ${card(
        '推送',
        `<label class="p-field">
           <span class="p-label">推送时间（北京时间 HH:MM）</span>
           <input class="p-input" name="pushTime" value="${escapeHtml(prefs.pushTime)}" placeholder="09:00">
         </label>
         <label class="p-field">
           <span class="p-label">每次条数（1–8）</span>
           <input class="p-input" name="digestCount" value="${String(prefs.digestCount)}" inputmode="numeric">
         </label>
         <label class="p-field">
           <span class="p-label">推送间隔（1–30 天）</span>
           <input class="p-input" name="intervalDays" value="${String(prefs.intervalDays)}" inputmode="numeric">
         </label>`,
      )}
      ${card(
        '偏好',
        `<label class="p-field">
           <span class="p-label">语言（逗号分隔，留空为全部）</span>
           <input class="p-input" name="languages" value="${escapeHtml(languages)}" placeholder="python, rust">
         </label>
         <label class="p-field">
           <span class="p-label">关键词（逗号分隔，留空为不限制）</span>
           <input class="p-input" name="keywords" value="${escapeHtml(keywords)}" placeholder="ai, agent">
         </label>
         <label class="p-field">
           <span class="p-label">天气城市</span>
           <select class="p-select" name="weatherCity">${cityOptions}</select>
           <span class="p-hint">自动只到城市级；不准时手动选一个。</span>
         </label>`,
      )}
      ${card('保存', '<button class="p-btn block" type="submit">保存设置</button>')}
     </form>
     ${card(
       'AI Key',
       llmModel
         ? `<div class="p-row-sub p-mb">已配置：${escapeHtml(llmModel)}。互动使用你自己的额度；Key 加密存储，可随时删除。</div>
            <div class="p-actions">
              <a class="p-btn ghost" href="${escapeHtml(modelEntryLink(userid))}">更换</a>
              <form method="post" action="${href(token, { view: 'settings' })}">
                <input type="hidden" name="action" value="clear-llm">
                <button class="p-btn danger" type="submit">删除我的 AI Key</button>
              </form>
            </div>`
         : `<div class="p-row-sub p-mb">互动里的中文简介可以用你自己的 AI Key，不占用运营方额度。</div>
            <a class="p-btn ghost" href="${escapeHtml(modelEntryLink(userid))}">配置我的 AI Key</a>`,
     )}
     ${card(
       '面板链接',
       `<div class="p-row-sub p-mb">链接可被转发，重置后旧链接立即失效。</div>
        <form method="post" action="${href(token, { view: 'settings' })}">
          <input type="hidden" name="action" value="reset">
          <button class="p-btn danger" type="submit">重置面板链接</button>
        </form>`,
     )}`,
  );
}

function splitList(value: string): string[] {
  return value
    .split(/[,，、\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

interface ActionOutcome {
  notice?: string;
  error?: string;
}

/** 面板里的所有写操作：与聊天命令共用服务层，这里只做输入校验与文案映射。 */
async function applyAction(
  userid: string,
  view: string,
  fields: Record<string, string>,
): Promise<ActionOutcome> {
  // 账号/凭据的生命周期动作：任何视图都能触发，优先级最高。
  if (fields.action === 'clear-llm') {
    await clearUserLlm(userid);
    return { notice: '已删除你的 AI Key，互动回到规则模式。' };
  }
  if (fields.action === 'unbind-github') {
    await clearGithubBinding(userid);
    return { notice: '已解除 GitHub 绑定。收藏仍保留在本地。' };
  }
  if (fields.action === 'sync-stars') {
    const auth = await loadBindingAuth(userid);
    if (auth.kind !== 'ok') {
      return { error: '先绑定 GitHub，再从 GitHub 同步。' };
    }
    const imported = await importGithubStars(userid, auth.token, auth.login ?? '');
    return imported > 0
      ? { notice: `从 GitHub 同步了 ${imported} 个收藏。` }
      : { error: '没有同步到收藏（可能是 star 列表为空或 GitHub 暂时不可用）。' };
  }

  if (view === 'tracking') {
    if (fields.action === 'track') {
      const result = await addTrackedRepo(userid, fields.repo ?? '');
      if (result.ok) {
        return {
          notice: `跟上了：${result.displayName}（★${result.stars}）。有 release 或 star 加速时我会说一声。`,
        };
      }
      return {
        error:
          result.reason === 'usage'
            ? '用法：owner/repo 或 GitHub 链接'
            : result.reason === 'limit'
              ? '最多 10 个。先取消一个。'
              : '这个仓库暂时读不到，等下再试。',
      };
    }
    if (fields.action === 'untrack') {
      await removeTracked(userid, fields.identifier ?? '');
      return { notice: '不跟了。' };
    }
  }

  if (view === 'favorites' && (fields.action === 'favorite' || fields.action === 'unfavorite')) {
    return applyFavoriteAction(
      userid,
      fields.action,
      fields.fullName ?? '',
    );
  }

  if (view === 'memory') {
    if (fields.action === 'remember') {
      const status = await rememberFact(userid, fields.fact ?? '');
      if (status === 'added') return { notice: '记住了。' };
      if (status === 'duplicate') return { notice: '这条已经记过了。' };
      if (status === 'full') {
        return { error: `记忆满了（${PROFILE_MAX_FACTS} 条）。先删一条。` };
      }
      return { error: '没写进去，稍后再试。' };
    }
    if (fields.action === 'forget') {
      const term = (fields.term ?? '').trim();
      if (term === '') return { error: '要删哪一条？' };
      const removed = await forgetFacts(userid, term);
      return removed.length > 0
        ? { notice: `删了：${removed.join('；')}` }
        : { error: '没找到匹配的记忆。' };
    }
    if (fields.action === 'forget-all') {
      const ok = await forgetAll(userid);
      return ok ? { notice: '清空了。' } : { error: '没清掉，稍后再试。' };
    }
  }

  if (view === 'overview' || view === 'settings') {
    if (fields.action === 'unsubscribe') {
      await mergePreferences(userid, {}, { active: false });
      return { notice: '先安静几天。收藏和跟踪都还在。' };
    }
    if (fields.action === 'resubscribe') {
      await mergePreferences(userid, {}, { active: true });
      // 推送时间可能刚改过（暂停期间也能改），提示必须跟着用户设置走，不能写死 9 点。
      const sub = await readSubscriber(userid);
      const { pushTime } = normalizePreferences(sub?.preferences ?? {});
      return { notice: `好，已恢复推送。下次 ${pushTime} 见。` };
    }
  }

  return {};
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

  // 30 秒短缓存：同一页面连点/返回直接回 HTML，连天气和 DB 都不用碰。
  // 带查询参数的视图（搜索 q、历史 date）不缓存。
  const noQuery =
    queryParam(req, 'q') === '' &&
    queryParam(req, 'date') === '' &&
    queryParam(req, 'i') === '';
  const cacheable = method === 'GET' && noQuery;
  const dirty = cacheable ? await readPanelDirty(userid) : '';
  if (cacheable) {
    const hit = await readPanelHtml(userid, parsed.version, view, dirty);
    if (hit !== null) {
      res.setHeader('x-panel-cache', 'hit');
      sendHtml(res, 200, hit);
      return;
    }
  }

  // 每次请求只取一次天气（服务层按城市缓存 3 小时），所有视图共用。
  const weather = await weatherForPanel(userid, req.headers);
  const fields = method === 'POST' ? readBodyFields(req.body) : {};
  let notice: string | undefined;
  let error: string | undefined;

  const sendView = async (html: string): Promise<void> => {
    if (cacheable) {
      await writePanelHtml(userid, parsed.version, view, dirty, html);
    }
    res.setHeader('x-panel-cache', cacheable ? 'miss' : 'off');
    sendHtml(res, 200, html);
  };

  if (method === 'POST' && view === 'settings' && fields.action === 'reset') {
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
        card(
          '新链接好了，旧的已经失效',
          `<div class="p-row-sub p-break"><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></div>`,
        ),
      ),
    );
    return;
  }

  if (method === 'POST' && view === 'settings' && fields.action === undefined) {
    const pushTime = (fields.pushTime ?? '').trim();
    const digestCount = Number(fields.digestCount);
    const intervalDays = Number(fields.intervalDays);
    const validation =
      !PUSH_TIME_RE.test(pushTime)
        ? '推送时间需为 HH:MM（北京时间），例如 09:00'
        : !Number.isInteger(digestCount) || digestCount < 1 || digestCount > 8
          ? '条数需为 1–8 的整数'
          : !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 30
            ? '间隔需为 1–30 的整数'
            : null;
    if (validation !== null) {
      sendHtml(res, 400, await renderSettings(userid, token, null, undefined, validation));
      return;
    }
    const weatherCityRaw = (fields.weatherCity ?? AUTO_CITY).trim();
    const weatherCity =
      cityBySlug(weatherCityRaw) === null ? AUTO_CITY : weatherCityRaw;
    await mergePreferences(userid, {
      pushTime,
      digestCount,
      intervalDays,
      languages: splitList(fields.languages ?? ''),
      keywords: splitList(fields.keywords ?? ''),
      weatherCity,
    });
    notice = '改好了。';
  } else if (method === 'POST') {
    const outcome = await applyAction(userid, view, fields);    notice = outcome.notice;
    error = outcome.error;
  }

  // 写操作后立刻让所有缓存页面失效（键里带 dirty，下一次 GET 必回源）。
  if (method === 'POST') await bumpPanelDirty(userid);

  // 所有视图共用同一个天气结果（服务层 3 小时缓存），不再退化成云。
  if (view === 'tracking') {
    await sendView(await renderTracking(userid, token, weather, notice, error));
    return;
  }
  if (view === 'history') {
    await sendView(await renderHistory(userid, token, queryParam(req, 'date'), weather));
    return;
  }
  if (view === 'favorites') {
    await sendView(await renderFavorites(userid, token, queryParam(req, 'q'), weather, notice, error));
    return;
  }
  if (view === 'memory') {
    await sendView(await renderMemory(userid, token, weather, notice, error));
    return;
  }
  if (view === 'checkup') {
    const index = Number(queryParam(req, 'i'));
    await sendView(await renderCheckup(userid, token, weather, Number.isFinite(index) ? index : 0));
    return;
  }
  if (view === 'settings') {
    await sendView(await renderSettings(userid, token, weather, notice, error));
    return;
  }
  await sendView(await renderOverview(userid, token, weather, notice, error));
}
