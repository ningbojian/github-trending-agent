import { fitOpportunityText, buildOpportunityArticles } from '../opportunities/format.js';
import { normalizePreferences } from '../agent/preferences.js';
import { readSubscription } from '../agent/subscription-store.js';
import { loadUserSignals } from '../agent/taste.js';
import { readLatestOpportunityPool } from '../opportunities/pool.js';
import {
  rankOpportunities,
  type OpportunitySignals,
} from '../opportunities/rank.js';
import { readHiddenOpportunities } from '../opportunities/store.js';
import type { OpportunityItem } from '../opportunities/types.js';
import { sendWeComNews, sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

const EMPTY_TEXT = '今天的机会池还没准备好，晚点再试。';
const NO_MATCH_TEXT = '今天没有通过质量门槛的机会，明天再看。';
const FAIL_TEXT = '机会暂时取不到，稍后再试。';

/**
 * 企微「机会」回复：默认 3 条，纯文本 ≤1900 字节。
 * 顺序由 rankOpportunities 决定；事实/链接来自池，不调模型。
 */
export function formatOpportunityReply(items: OpportunityItem[]): string {
  return fitOpportunityText(
    `今天的机会（${items.length} 条）`,
    items,
    '面板里可以追踪/不感兴趣；回复「面板」打开。',
  );
}

/** 命令入口：读共享池 + 本地信号 → 内存排序 → 发送。 */
export async function handleOpportunities(
  msg: InboundMessage,
): Promise<void> {
  const userid = msg.fromUserName;
  try {
    const now = new Date();
    const pool = await readLatestOpportunityPool(now);
    if (!pool) {
      await sendWeComText(userid, EMPTY_TEXT);
      return;
    }

    let prefs = normalizePreferences({});
    try {
      const sub = await readSubscription(userid);
      prefs = normalizePreferences(sub?.preferences ?? {});
    } catch (err) {
      console.warn('opportunities: subscription read failed:', err);
    }

    const [taste, hidden] = await Promise.all([
      loadUserSignals(userid, now),
      readHiddenOpportunities(userid),
    ]);

    const signals: OpportunitySignals = {
      languages: prefs.languages,
      topics: prefs.topics,
      keywords: prefs.keywords,
      languageBoost: taste.languageBoost,
      topicBoost: taste.topicBoost,
      favoriteRepos: taste.starred,
      trackedRepos: new Set(),
      hidden,
      shown: new Set(),
    };

    const items = rankOpportunities(pool.items, signals, {
      limit: 3,
      contribute: 2,
      research: 1,
    });
    if (items.length === 0) {
      await sendWeComText(userid, NO_MATCH_TEXT);
      return;
    }
    try {
      await sendWeComNews(userid, buildOpportunityArticles(items));
    } catch (err) {
      // news 被拒（标题/图片/客户端限制）时回退到现有文本卡片。
      console.warn('opportunity news failed, falling back to text:', err);
      await sendWeComText(userid, formatOpportunityReply(items));
    }
  } catch (err) {
    console.error('handleOpportunities failed:', err);
    try {
      await sendWeComText(userid, FAIL_TEXT);
    } catch {
      // 兜底发送也失败：只记日志，不递归。
    }
  }
}
