import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache, subscribers } from '../db/schema.js';
import {
  buildOpportunityArticles,
  fitOpportunityText,
} from '../opportunities/format.js';
import { readLatestOpportunityPool } from '../opportunities/pool.js';
import { rankOpportunities } from '../opportunities/rank.js';
import {
  markOpportunitiesShown,
  readHiddenOpportunities,
  readShownOpportunities,
} from '../opportunities/store.js';
import { sendWeComNews, sendWeComText } from '../wecom/api.js';
import type { NewsArticle } from '../wecom/news.js';
import { normalizePreferences } from './preferences.js';
import { loadUserSignals } from './taste.js';
import { shanghaiToday } from './time.js';

const CLAIM_PREFIX = 'opportunity-weekly-sent:v1:';
const CLAIM_TTL_MS = 2 * 24 * 60 * 60 * 1000;

const EMPTY_SIGNALS = {
  starred: new Set<string>(),
  languageBoost: new Map<string, number>(),
  topicBoost: new Map<string, number>(),
  suppressed: new Set<string>(),
};

async function tryClaim(
  userid: string,
  date: string,
  now: Date,
): Promise<boolean> {
  try {
    const rows = await db()
      .insert(kvCache)
      .values({
        key: `${CLAIM_PREFIX}${userid}:${date}`,
        value: { at: now.toISOString() },
        expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
      })
      .onConflictDoNothing({ target: kvCache.key })
      .returning({ key: kvCache.key });
    return rows.length > 0;
  } catch (err) {
    // 读不到 claim 就跳过：宁可这周不发，也不给同一个人发两遍。
    console.error('weekly opportunities claim failed:', err);
    return false;
  }
}

/**
 * 周一 10:00–12:00 由 cron 的 weekly gate 调用；每人每天最多一次。
 * 2 填坑 + 1 研究；池空/关掉偏好/无合格条目都跳过。
 */
export async function pushWeeklyOpportunities(
  now: Date = new Date(),
  options: {
    sendNews?: (userid: string, articles: NewsArticle[]) => Promise<void>;
    sendText?: (userid: string, text: string) => Promise<void>;
  } = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  const pool = await readLatestOpportunityPool(now);
  if (!pool) return { sent: 0, skipped: 0, failed: 0 };

  const rows = await db()
    .select({
      userid: subscribers.wecomUserid,
      preferences: subscribers.preferences,
    })
    .from(subscribers)
    .where(eq(subscribers.active, true));

  const date = shanghaiToday(now);
  const sendNews = options.sendNews ?? sendWeComNews;
  const sendText = options.sendText ?? sendWeComText;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const prefs = normalizePreferences(row.preferences ?? {});
    if (!prefs.weeklyOpportunities) {
      skipped += 1;
      continue;
    }
    if (!(await tryClaim(row.userid, date, now))) {
      skipped += 1;
      continue;
    }
    try {
      const [taste, hidden, shown] = await Promise.all([
        loadUserSignals(row.userid, now).catch(() => EMPTY_SIGNALS),
        readHiddenOpportunities(row.userid),
        readShownOpportunities(row.userid),
      ]);
      const items = rankOpportunities(
        pool.items,
        {
          languages: prefs.languages,
          topics: prefs.topics,
          keywords: prefs.keywords,
          languageBoost: taste.languageBoost,
          topicBoost: taste.topicBoost,
          favoriteRepos: taste.starred,
          trackedRepos: new Set(),
          hidden,
          shown,
        },
        { limit: 3, contribute: 2, research: 1 },
      );
      if (items.length === 0) {
        skipped += 1;
        continue;
      }
      const contribute = items.filter(
        (item) => item.kind === 'contribute',
      ).length;
      const research = items.filter((item) => item.kind === 'research').length;
      const text = fitOpportunityText(
        `🧭 本周机会（${contribute} 填坑 + ${research} 研究）`,
        items,
        '想关掉：到面板设置里关闭「每周机会」。',
      );
      try {
        await sendNews(row.userid, buildOpportunityArticles(items));
      } catch (err) {
        console.warn(
          'weekly opportunity news failed, falling back to text:',
          err,
        );
        await sendText(row.userid, text);
      }
      await markOpportunitiesShown(
        row.userid,
        items.map((item) => item.id),
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(
        'weekly opportunities failed for',
        row.userid,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { sent, skipped, failed };
}
