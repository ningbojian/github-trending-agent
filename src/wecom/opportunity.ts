import { normalizePreferences } from '../agent/preferences.js';
import { readSubscription } from '../agent/subscription-store.js';
import { loadUserSignals } from '../agent/taste.js';
import { readOpportunityPool } from '../opportunities/pool.js';
import {
  rankOpportunities,
  type OpportunitySignals,
} from '../opportunities/rank.js';
import { readHiddenOpportunities } from '../opportunities/store.js';
import type { OpportunityItem } from '../opportunities/types.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

const EMPTY_TEXT = '今天的机会池还没准备好，晚点再试。';
const NO_MATCH_TEXT = '今天没有通过质量门槛的机会，明天再看。';
const FAIL_TEXT = '机会暂时取不到，稍后再试。';

/**
 * 企微「机会」回复：2 填坑 + 1 研究，纯文本 ≤1900 字节。
 * 顺序由 rankOpportunities 决定；事实/链接来自池，不调模型。
 */
export function formatOpportunityReply(items: OpportunityItem[]): string {
  const contribute = items.filter((item) => item.kind === 'contribute').length;
  const research = items.filter((item) => item.kind === 'research').length;
  const header = `🧭 今天的机会（${contribute} 填坑 + ${research} 研究）`;
  const footer = '面板里可以追踪/不感兴趣；回复「面板」打开。';

  const cards = items.map((item, index) => {
    const kind = item.kind === 'contribute' ? '填坑' : '研究';
    return [
      `${index + 1}. [${kind}] ${item.repo} #${item.issueNumber}`,
      item.title,
      `为什么：${item.why}`,
      `第一步：${item.firstStep}`,
      `难度：${item.effort} · 置信度：${item.confidence}`,
      item.url,
    ].join('\n');
  });

  for (let count = cards.length; count >= 1; count -= 1) {
    const text = [header, '', ...cards.slice(0, count), footer].join('\n\n');
    if (Buffer.byteLength(text, 'utf8') <= 1900) return text;
  }

  const fallback = [header, '', cards[0] ?? '', footer].join('\n\n');
  return fallback;
}

/** 命令入口：读共享池 + 本地信号 → 内存排序 → 发送。 */
export async function handleOpportunities(
  msg: InboundMessage,
): Promise<void> {
  const userid = msg.fromUserName;
  try {
    const now = new Date();
    const pool = await readOpportunityPool(now);
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
    await sendWeComText(userid, formatOpportunityReply(items));
  } catch (err) {
    console.error('handleOpportunities failed:', err);
    try {
      await sendWeComText(userid, FAIL_TEXT);
    } catch {
      // 兜底发送也失败：只记日志，不递归。
    }
  }
}
