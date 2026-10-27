import {
  buildDigestFromSnapshot,
  buildDigestWithEntries,
  markDigestSent,
  saveRecentResults,
} from '../agent/digest.js';
import { getDailySnapshot } from '../agent/digest-snapshot.js';
import { recordPush } from '../agent/push-history.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 新用户礼包：欢迎语 + 首日简报（Task 6）。
 *
 * 触发点有两处，行为一致：
 * - 用户从企业微信进入应用（event/enter_agent，含刚加入后的首次进入）；
 * - 用户直接发首条文本消息（router 的 ensureSubscriber 判定为新用户）。
 *
 * 产品决策（计划已定）：先发 3 行短欢迎（身份 + 已开通简报 + 一个示例 + 帮助入口），
 * 紧接着发今日简报——第一屏不长篇说明书，而是立刻给价值。
 *
 * 顺序不可交换：简报写 search_caches 必须发生在随后原消息的回复写缓存之前，
 * 这样「收藏 N」始终指向用户最后看到的那条消息（搜索回复覆盖简报缓存）。
 *
 * 全链路 fail-open：任一步失败只记日志，绝不让「送礼包」把聊天主链路带崩。
 */

/** 欢迎语：身份 + 自动订阅说明 + 一个示例 + 帮助入口（3 行）。 */
export const WELCOME_MESSAGE = [
  '你好！我是 GitHub 热榜助手，已为你自动开通每日简报（默认每天 09:00 北京时间推送）。',
  '直接发自然语言就能搜项目，例如：本周 python 的 ai 项目',
  '回复「帮助」查看全部指令（收藏、绑定 GitHub、改推送时间/频率等）。',
].join('\n');

/**
 * 发送欢迎语与首日简报。
 * - 简报发送成功才写 search_caches（「收藏 N」绝不指向用户没收到的列表）；
 * - 发送成功即置 last_digest_at，当天定时推送不再重复；
 * - 构建/发送失败都不标记，留给后续定时推送补发。
 */
export async function sendWelcomeFlow(msg: InboundMessage): Promise<void> {
  const userId = msg.fromUserName;

  try {
    await sendWeComText(userId, WELCOME_MESSAGE);
  } catch (err) {
    // 欢迎语失败不阻塞简报：用户拿到价值比看到自我介绍更重要。
    console.warn('welcome send failed:', err);
  }

  let digest: { content: string; entries: { fullName: string }[] };
  try {
    // 优先复用当日快照：同一份榜单当天只生成一次，礼包因此多一段概览、
    // 少一次模型调用。快照不可用才走实时构建（自带降级）。
    const snapshot = await getDailySnapshot();
    digest = snapshot
      ? await buildDigestFromSnapshot({ preferences: {} }, snapshot)
      : await buildDigestWithEntries({ preferences: {} });
  } catch (err) {
    console.error('first-day digest build failed:', err);
    return;
  }

  try {
    await sendWeComText(userId, digest.content);
  } catch (err) {
    console.error('first-day digest send failed:', err);
    return;
  }

  try {
    await saveRecentResults(userId, digest.entries);
  } catch (err) {
    // 缓存写失败不能翻转「已送达」：用户在微信里仍然收到了这份简报。
    console.error('first-day digest cache write failed:', err);
  }
  // 礼包也算「推过」：否则第二天的定时简报会把同一批仓库再发一遍。
  // 礼包本身不走任何过滤（新用户从零开始，给满最合适）。
  if (digest.entries.length > 0) {
    await recordPush(
      userId,
      digest.entries.map((entry) => entry.fullName),
    );
  }
  try {
    await markDigestSent(userId);
  } catch (err) {
    // 标记失败只意味着当天可能再收到一次定时简报，属可接受降级。
    console.error('first-day digest mark failed:', err);
  }
}
