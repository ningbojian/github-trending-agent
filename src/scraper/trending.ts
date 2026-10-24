import { sql } from 'drizzle-orm';
import { parse } from 'node-html-parser';
import { db } from '../db/client.js';
import { repos, trendingEntries } from '../db/schema.js';
import { SCRAPER_LANGUAGES } from '../config.js';

/** 解析出的单条 trending 仓库。 */
export interface ParsedRepo {
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  language: string | null;
  stars: number;
  starsDelta: number;
  isNew: boolean;
  rank: number;
}

export type TrendingPeriod = 'daily' | 'weekly';

/** 总榜（无语言过滤）在 trending_entries.language 中的哨兵值。 */
const LANGUAGE_ALL = 'all';

const USER_AGENT = 'github-trending-agent/0.1 (trending scraper)';

/** "1,234" → 1234；无法解析时返回 null。 */
function toInt(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
}

/**
 * 纯函数：从 GitHub Trending 页面 HTML 解析仓库列表。
 * 按 `article.Box-row` 切分；页面改版（找不到条目）或空输入时返回 []。
 * 不发任何网络请求。
 */
export function parseTrendingHtml(
  html: string,
  period: TrendingPeriod,
): ParsedRepo[] {
  const articles = parse(html).querySelectorAll('article.Box-row');
  const deltaUnit = period === 'weekly' ? 'this week' : 'today';
  const deltaPattern = new RegExp(`([\\d,]+)\\s+stars\\s+${deltaUnit}`, 'i');

  const parsed: ParsedRepo[] = [];
  for (const [index, article] of articles.entries()) {
    const href =
      article.querySelector('h2 a[href^="/"]')?.getAttribute('href') ?? '';
    const repoPath = href.match(/^\/([^/]+)\/([^/]+)$/);
    const stars = toInt(article.querySelector('a[href$="/stargazers"]')?.text);
    // 缺少仓库链接或 star 数说明页面结构已改版，跳过该条。
    if (repoPath == null || stars == null) continue;
    const [, owner, name] = repoPath;

    parsed.push({
      fullName: `${owner}/${name}`,
      name,
      owner,
      description: article.querySelector('p.col-9')?.text.trim() || null,
      language:
        article
          .querySelector('span[itemprop="programmingLanguage"]')
          ?.text.trim() || null,
      stars,
      starsDelta: toInt(article.text.match(deltaPattern)?.[1]) ?? 0,
      // "New" 徽标使用 GitHub 的 accent Label 样式。
      isNew: article.querySelector('.Label--accent') != null,
      rank: index + 1,
    });
  }
  return parsed;
}

/**
 * 抓取总榜与 SCRAPER_LANGUAGES 各语言的 daily 页，
 * 并 upsert repos + trending_entries（当日同键幂等覆盖）。
 *
 * date 用 UTC 当日（与 GitHub Actions 运行时区一致）。
 * inserted 统计本次写入（含覆盖更新）的条目总数；languages 统计有产出的榜单页数。
 * 单页失败仅告警并跳过；全部失败时返回 { inserted: 0, languages: 0 }。
 */
export async function scrapeAndUpsert(): Promise<{
  inserted: number;
  languages: number;
}> {
  const pages: Array<{ url: string; language: string }> = [
    { url: 'https://github.com/trending?since=daily', language: LANGUAGE_ALL },
    ...SCRAPER_LANGUAGES.map((language) => ({
      // c++ → c%2B%2B、c# → c%23（# 原样会变成 URL fragment）；
      // 某语言榜 404 时下方沿用「告警并跳过」，不重试。
      url: `https://github.com/trending/${encodeURIComponent(language)}?since=daily`,
      language,
    })),
  ];

  const database = db();
  const today = new Date().toISOString().slice(0, 10);
  let inserted = 0;
  let languages = 0;

  for (const page of pages) {
    let html: string;
    try {
      const response = await fetch(page.url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      });
      if (!response.ok) {
        console.warn(`[scraper] ${page.url} -> HTTP ${response.status}, skip`);
        continue;
      }
      html = await response.text();
    } catch (error) {
      console.warn(
        `[scraper] fetch ${page.url} failed: ${(error as Error).message}`,
      );
      continue;
    }

    const parsed = parseTrendingHtml(html, 'daily');
    if (parsed.length === 0) {
      console.warn(`[scraper] ${page.url} parsed 0 entries, skip`);
      continue;
    }

    // 先写 repos（trending_entries 有外键依赖），同页内并发提交。
    await Promise.all(
      parsed.map((repo) =>
        database
          .insert(repos)
          .values({
            fullName: repo.fullName,
            name: repo.name,
            owner: repo.owner,
            description: repo.description,
            language: repo.language,
            topics: [], // trending 页不含 topics，留给 GitHub API 补全
            stars: repo.stars,
            htmlUrl: `https://github.com/${repo.fullName}`,
          })
          .onConflictDoUpdate({
            target: repos.fullName,
            set: {
              stars: repo.stars,
              // coalesce(excluded.x, repos.x)：页面漂移给出 null 时保留行内已有值
              // （enrich 补全的 description/language 不被每日 upsert 清空），
              // 非 null 时仍以页面值覆盖。静态 SQL，无用户输入。
              description: sql`coalesce(excluded.description, ${repos.description})`,
              language: sql`coalesce(excluded.language, ${repos.language})`,
            },
          }),
      ),
    );

    await Promise.all(
      parsed.map((repo) =>
        database
          .insert(trendingEntries)
          .values({
            fullName: repo.fullName,
            date: today,
            period: 'daily',
            language: page.language,
            rank: repo.rank,
            starsAtCapture: repo.stars,
            starsDelta: repo.starsDelta,
            isNew: repo.isNew,
            source: page.url,
          })
          .onConflictDoUpdate({
            // 与 schema 唯一约束一致：当日同榜同仓库覆盖更新而非插入新行。
            target: [
              trendingEntries.date,
              trendingEntries.period,
              trendingEntries.language,
              trendingEntries.fullName,
            ],
            set: {
              rank: repo.rank,
              starsAtCapture: repo.stars,
              starsDelta: repo.starsDelta,
              isNew: repo.isNew,
              source: page.url,
            },
          }),
      ),
    );

    inserted += parsed.length;
    languages += 1;
  }

  return { inserted, languages };
}
