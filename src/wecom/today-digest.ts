import { eq } from 'drizzle-orm';
import { pushDigests } from '../agent/digest.js';
import { shanghaiToday } from '../agent/time.js';
import { db } from '../db/client.js';
import { subscribers } from '../db/schema.js';
import { note } from '../obs/trace.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/** 北京时间 HH:MM。 */
function beijingTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(11, 16);
}

/**
 * 「每日推送」/「今日简报」：手动要一份今天的简报。
 *
 * 必须走**和定时推送完全相同的引擎**（pushDigests）：7 天去重、增长门槛、
 * 口味排序、收藏过滤、search_caches 全都在那里面。早期版本直接拿快照前 8 条，
 * 结果把昨天推过的仓库又发一遍——和「每日推送」这个名字完全不符。
 *
 * - 忽略「还没到推送时间」：用户主动要，不该等到 10:00
 * - 保留「当天已发」与「间隔天数」：避免和定时推送重复
 * - 当天已发过：明确告诉他，而不是再发一份一样的
 */
export async function handleTodayDigest(msg: InboundMessage): Promise<void> {
  const userid = msg.fromUserName;
  try {
    const row = (
      await db()
        .select()
        .from(subscribers)
        .where(eq(subscribers.wecomUserid, userid))
        .limit(1)
    )[0];
    if (row === undefined) {
      await sendWeComText(userid, '先发「订阅」开通每日简报，再让我推送。');
      return;
    }
    if (!row.active) {
      await sendWeComText(
        userid,
        '你现在处于退订状态。发「订阅 <方向或关键词>」可以恢复每日简报。',
      );
      return;
    }

    const today = shanghaiToday(new Date());
    if (row.lastDigestAt) {
      const last = new Date(row.lastDigestAt);
      if (shanghaiToday(last) === today) {
        await sendWeComText(
          userid,
          `今天 ${beijingTime(last)} 已经发过了。想再看可以直接往上翻那张卡片。`,
        );
        return;
      }
    }

    // 与定时推送同一套门控与渲染：去重、口味、增长门槛、search_caches。
    const result = await pushDigests(new Date(), {
      onlyUserId: userid,
      ignorePushTime: true,
      budgetMs: 90_000,
    });
    note('manual-digest', `sent=${result.sent} skipped=${result.skipped}`);
    if (result.sent === 0) {
      await sendWeComText(
        userid,
        '今天暂时没有可发的新项目（或还没到你的推送间隔），晚点再试。',
      );
    }
  } catch (err) {
    console.error('handleTodayDigest failed:', err);
    try {
      await sendWeComText(userid, '今天的简报暂时取不到，稍后再试。');
    } catch {
      // 连兜底都失败：只记日志，不递归。
    }
  }
}
