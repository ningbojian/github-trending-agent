/**
 * 「我的订阅」handler（只读）。
 *
 * 三种结果必须分清，别把故障说成事实：
 * - 有订阅者行 → 发摘要；
 * - 没有该用户的行 → 引导开通；
 * - 读取失败 → 「⚠️ 暂时读不到」，**绝不**说成「你没有订阅」。
 */

import { formatSubscriptionSummary } from '../agent/subscription-summary.js';
import { readSubscription, removeSubscriptionTerm } from '../agent/subscription-store.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/** 没有订阅者行时的引导文案（新用户通常先收到欢迎语，这里兜住直接问的人）。 */
export const NO_SUBSCRIPTION_REPLY =
  '你还没有订阅设置。发「订阅 <偏好>」即可开通每日简报，例如：订阅 python,ai';

/** 读取失败文案：只说「读不到」，不猜测用户到底订没订。 */
export const SUBSCRIPTION_FAILURE_REPLY = '⚠️ 暂时读不到订阅设置，请稍后再试。';

/** 「我的订阅」带了多余内容时的用法提示。 */
export const MY_SUBSCRIPTION_USAGE_REPLY = '用法：直接回复「我的订阅」即可（无需参数）';

/**
 * 只读展示当前订阅；不写库、不改 active。
 * 回执发送失败以 rejected promise 传播，由 router 的 dispatchSafely 兜底。
 */
export async function handleMySubscription(msg: InboundMessage): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof readSubscription>>;
  try {
    snapshot = await readSubscription(msg.fromUserName);
  } catch (err) {
    console.error('handleMySubscription read failed:', err);
    await sendWeComText(msg.fromUserName, SUBSCRIPTION_FAILURE_REPLY);
    return;
  }
  if (snapshot === null) {
    await sendWeComText(msg.fromUserName, NO_SUBSCRIPTION_REPLY);
    return;
  }
  await sendWeComText(
    msg.fromUserName,
    formatSubscriptionSummary(snapshot.preferences, snapshot.active),
  );
}

/** 「取消订阅 <关键词>」前缀（与 router 的分发正则保持一致）。 */
const CANCEL_SUBSCRIPTION_PREFIX = '取消订阅';

/** 「取消订阅」缺关键词时的用法提示。 */
export const CANCEL_SUBSCRIPTION_USAGE_REPLY =
  '用法：「取消订阅 <关键词>」，例如：取消订阅 rpa；发「我的订阅」查看当前关键词。';

/**
 * 「取消订阅 <关键词>」handler。
 *
 * 只删订阅关键词，不动 active（退订是「退订」的事）——冲突提示里给的
 * 就是这个命令，用户回一句就能把那个方向从订阅里去掉。
 * 命中才写库；存储失败说「改不了」，绝不谎称已删。
 */
export async function handleCancelSubscriptionTerm(msg: InboundMessage): Promise<void> {
  const content = msg.content.trim();
  if (!content.startsWith(CANCEL_SUBSCRIPTION_PREFIX)) {
    return;
  }
  const term = content.slice(CANCEL_SUBSCRIPTION_PREFIX.length).trim();
  if (term === '') {
    await sendWeComText(msg.fromUserName, CANCEL_SUBSCRIPTION_USAGE_REPLY);
    return;
  }
  try {
    const result = await removeSubscriptionTerm(msg.fromUserName, term);
    if (!result.removed) {
      await sendWeComText(
        msg.fromUserName,
        `订阅关键词里没有「${term}」。发「我的订阅」看看当前设置。`,
      );
      return;
    }
    const tail =
      result.keywords.length > 0
        ? `当前关键词：${result.keywords.join('、')}。`
        : '当前没有偏好关键词，之后按全站热榜推荐。';
    await sendWeComText(msg.fromUserName, `✅ 已从订阅关键词里移除「${term}」。${tail}`);
  } catch (err) {
    console.error('handleCancelSubscriptionTerm failed:', err);
    try {
      await sendWeComText(msg.fromUserName, SUBSCRIPTION_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('cancel subscription fallback reply failed:', fallbackErr);
    }
  }
}
