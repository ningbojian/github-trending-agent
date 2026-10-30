import {
  buildDigestForSubscriber,
  buildDigestNewsFromSnapshot,
  saveRecentResults,
} from '../agent/digest.js';
import { getDailySnapshot } from '../agent/digest-snapshot.js';
import { readSubscription } from '../agent/subscription-store.js';
import { note } from '../obs/trace.js';
import { sendWeComNews, sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「每日推送」/「今日简报」：手动要一份今天的简报。
 *
 * 必须和定时推送走同一个渲染器（news 卡片），否则用户在聊天里要简报时
 * 拿到的是一份纯文本列表——和每天 9:10 收到的卡片完全两个样子。
 * 这里不做「最近已发过就跳过」的去重：用户主动要，就再发一次。
 */
export async function handleTodayDigest(msg: InboundMessage): Promise<void> {
  const userid = msg.fromUserName;
  try {
    const sub = await readSubscription(userid);
    const subject = sub ?? { preferences: {} };
    const snapshot = await getDailySnapshot();

    if (snapshot === null) {
      note('format', 'text（无快照）');
      await sendWeComText(userid, await buildDigestForSubscriber(subject));
      return;
    }

    const news = await buildDigestNewsFromSnapshot(subject, snapshot);
    if (news.entries.length === 0) {
      await sendWeComText(userid, '今天还没有可发的榜单，稍后再试试。');
      return;
    }

    try {
      await sendWeComNews(userid, news.articles);
      note('format', `news ${news.articles.length} 篇`);
    } catch (err) {
      // 与定时推送同一套兜底：卡片被拒就退回文本，绝不静默。
      note('news-fallback', err instanceof Error ? err.message : String(err));
      await sendWeComText(userid, await buildDigestForSubscriber(subject));
    }

    await saveRecentResults(userid, news.entries);
  } catch (err) {
    console.error('handleTodayDigest failed:', err);
    try {
      await sendWeComText(userid, '今天的简报暂时取不到，稍后再试。');
    } catch {
      // 连兜底都失败：只记日志，不递归。
    }
  }
}
