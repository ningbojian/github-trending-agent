import { buildExtraDigest, saveRecentResults } from '../agent/digest.js';
import {
  MAX_EXTRA_BATCHES,
  readBatch,
  recordBatch,
} from '../agent/digest-batch.js';
import { recordPush } from '../agent/push-history.js';
import { note } from '../obs/trace.js';
import { sendWeComNews, sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「更多」/「再来一批」/「还有吗」：接着发下一批（最多 8 条）。
 *
 * 候选池与主推送完全同源：口味排序、增长门槛、收藏过滤、7 天历史去重，
 * 再排除今天已经额外发过的。每批发送后覆盖 search_caches，所以「收藏 N」
 * 永远指向用户刚刚看到的那张卡片。
 */
export async function handleMoreDigest(msg: InboundMessage): Promise<void> {
  const userid = msg.fromUserName;
  try {
    const state = await readBatch(userid);
    if (state.batches >= MAX_EXTRA_BATCHES) {
      await sendWeComText(
        userid,
        '今天的候选已经看完了，明天 9 点后会有新榜。',
      );
      return;
    }

    const extra = await buildExtraDigest(userid, { limit: 8 });
    if (extra === null) {
      await sendWeComText(
        userid,
        '先发「订阅」开通每日简报，再让我给你推更多。',
      );
      return;
    }
    if (extra.articles.length === 0) {
      await sendWeComText(
        userid,
        '今天的候选已经看完了，明天 9 点后会有新榜。',
      );
      return;
    }

    try {
      await sendWeComNews(userid, extra.articles);
      note('more-send', `news ${extra.articles.length} 篇`);
    } catch (err) {
      // 卡片被拒：退回文本，带序号与链接。
      note('more-fallback', err instanceof Error ? err.message : String(err));
      const lines = [`今天的下一批（${extra.articles.length} 个）：`];
      extra.articles.forEach((article, index) => {
        lines.push(`${index + 1}. ${article.title} ${article.url}`);
      });
      await sendWeComText(userid, lines.join('\n'));
    }

    // 序号对齐：先把这一批写进 search_caches，再说「收藏 N」。
    await saveRecentResults(userid, extra.entries);
    // 写 7 天历史：下一批/明天都不会重复。
    await recordPush(
      userid,
      extra.entries.map((entry) => entry.fullName),
    );
    const next = await recordBatch(
      userid,
      extra.entries.map((entry) => entry.fullName),
    );

    const hint =
      extra.remaining > 0 && next.batches < MAX_EXTRA_BATCHES
        ? `还有 ${extra.remaining} 个候选，回「更多」接着看。`
        : '今天的候选已经看完了，明天 9 点后见。';
    await sendWeComText(userid, hint);
  } catch (err) {
    console.error('handleMoreDigest failed:', err);
    try {
      await sendWeComText(userid, '暂时取不到更多候选，稍后再试。');
    } catch {
      // 兜底发送也失败：只记日志，不递归。
    }
  }
}
