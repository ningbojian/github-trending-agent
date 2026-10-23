import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscribers } from '../db/schema.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 订阅开通与偏好设置（Task 13）：
 * - ensureSubscriber：首条消息自动开通订阅者行（新用户返回 true，router 据此先发欢迎语）；
 *   DB 错误 log warn 后 fail-open 返回 false —— 一条坏 insert 绝不阻塞聊天分发
 * - handleSubscribe：「订阅 <偏好>」→ preferences = { languages: [], keywords: tokens }
 *   整体替换（简单可预期；tokens 与 Task 10 简报的 keywords 提升同形），
 *   并同写 active: true —— 退订后再次订阅即恢复每日简报
 * - handleUnsubscribe：「退订」（精确匹配）→ active=false；不触碰 GitHub 绑定与收藏
 */

/** 新用户欢迎语（全中文功能说明：简报 / 搜索 / 绑定 / 订阅退订）。 */
export const WELCOME_MESSAGE = [
  '你好！我是 GitHub 热榜助手，已为你开通订阅。',
  '每日简报：每天自动推送 GitHub 热榜精选。',
  '搜索：直接发自然语言即可，如「本周 python 的 ai 项目」。',
  "收藏：先发'绑定'授权 GitHub，搜索后回复'收藏 N'即可收藏并同步 star。",
  '偏好：发「订阅 python,ai」设置简报偏好关键词；发「退订」停止每日简报。',
  '输入「帮助」可随时查看完整用法。',
].join('\n');

/** 裸「订阅」（无可解析关键词）时的用法提示。 */
export const SUBSCRIBE_USAGE_REPLY =
  '用法：「订阅 <偏好>」，多个偏好用逗号、顿号或空格分隔，例如：订阅 python,ai,agent';

/** 「订阅」更新成功的确认文案（回显当前偏好关键词）。 */
export const SUBSCRIBE_REPLY_PREFIX = '✅ 已订阅每日简报，当前偏好关键词：';

/** 「订阅」更新成功的确认文案尾句。 */
export const SUBSCRIBE_REPLY_SUFFIX = '（命中关键词的项目会优先展示）';

/** 「退订」确认文案（简报停止推送；GitHub 绑定与收藏不受影响）。 */
export const UNSUBSCRIBE_REPLY =
  '已退订每日简报，之后不再推送。发「订阅 <偏好>」可随时重新订阅。';

/** 「订阅」更新失败的兜底文案。 */
export const SUBSCRIBE_FAILURE_REPLY = '订阅失败，请稍后再试';

/** 「退订」更新失败的兜底文案。 */
export const UNSUBSCRIBE_FAILURE_REPLY = '退订失败，请稍后再试';

// ---------------------------------------------------------------------------
// handleHelp
// ---------------------------------------------------------------------------

/** 「帮助」回复：全中文完整用法说明（覆盖全部用户指令）。 */
export const HELP_MESSAGE = [
  '完整用法（回复对应指令即可）：',
  '· 自然语言搜索：直接发送描述即可，如「本周 python 的 ai 项目」。',
  '· 收藏：搜索后回复「收藏 N」，收藏第 N 条结果并同步 star（需先发「绑定」授权 GitHub）。',
  '· 取消收藏：回复「取消收藏 N」，取消第 N 条收藏并同步取消 star。',
  '· 我的收藏：回复「我的收藏」，查看全部已收藏项目。',
  '· 绑定：回复「绑定」，跳转 GitHub 授权页完成授权。',
  '· 订阅：回复「订阅 <偏好>」设置每日简报偏好，如「订阅 python,ai」。',
  '· 退订：回复「退订」，停止每日简报（可随时重新订阅）。',
].join('\n');

/**
 * 「帮助」handler（router 精确匹配「帮助」后分发）：
 * 发送完整用法说明；不读不写 DB。发送失败以 rejected promise 传播，
 * 由 router 的 dispatchSafely 捕获并回发兜底文案。
 */
export async function handleHelp(msg: InboundMessage): Promise<void> {
  await sendWeComText(msg.fromUserName, HELP_MESSAGE);
}

// ---------------------------------------------------------------------------
// ensureSubscriber
// ---------------------------------------------------------------------------

/**
 * 确保发送者已有订阅者行：缺失则 insert（active=true、空偏好）并返回 true（新用户）；
 * 已存在返回 false。任何 DB 错误 log warn 后返回 false（fail-open，不向外抛）。
 * 由 router 在 text 分发前调用；display_name 暂无来源（企微回调只带 userid），
 * 按 notNull 约束写空串占位。
 */
export async function ensureSubscriber(msg: InboundMessage): Promise<boolean> {
  try {
    const rows = await db()
      .select()
      .from(subscribers)
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    if (rows.length > 0) {
      return false;
    }
    await db()
      .insert(subscribers)
      .values({
        wecomUserid: msg.fromUserName,
        displayName: '',
        preferences: { languages: [], keywords: [] },
        active: true,
      });
    return true;
  } catch (err) {
    console.warn('ensureSubscriber failed:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// handleSubscribe / handleUnsubscribe
// ---------------------------------------------------------------------------

/** 「订阅」前缀（与 router 的分发正则保持一致；「退订」首字不同，不会互相吞）。 */
const SUBSCRIBE_PREFIX = '订阅';

/**
 * 解析偏好 tokens：按 中文/英文逗号、顿号、空白 切分，trim 后丢弃空串。
 */
function parseKeywords(rest: string): string[] {
  return rest
    .split(/[,，、\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function subscribedReply(keywords: string[]): string {
  return `${SUBSCRIBE_REPLY_PREFIX}${keywords.join('、')}${SUBSCRIBE_REPLY_SUFFIX}`;
}

/**
 * 「订阅 <偏好>」handler：
 * - 前缀不匹配 → 静默返回（router 层已拦；直接调用同此守卫）
 * - 无可解析关键词（裸「订阅」）→ 用法提示，不写库
 * - tokens 整体替换 preferences（languages 重置为空数组）→ 中文确认回显当前偏好
 * - 同时写 active: true：退订（active=false）后再次订阅即恢复每日简报，
 *   与 UNSUBSCRIBE_REPLY / HELP / README 承诺的「可随时重新订阅」一致
 */
export async function handleSubscribe(msg: InboundMessage): Promise<void> {
  try {
    const content = msg.content.trim();
    if (!content.startsWith(SUBSCRIBE_PREFIX)) {
      return;
    }
    const tokens = parseKeywords(content.slice(SUBSCRIBE_PREFIX.length));
    if (tokens.length === 0) {
      await sendWeComText(msg.fromUserName, SUBSCRIBE_USAGE_REPLY);
      return;
    }
    const preferences: { languages: string[]; keywords: string[] } = {
      languages: [],
      keywords: tokens,
    };
    await db()
      .update(subscribers)
      .set({ preferences, active: true })
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    await sendWeComText(msg.fromUserName, subscribedReply(tokens));
  } catch (err) {
    console.error('handleSubscribe failed:', err);
    try {
      await sendWeComText(msg.fromUserName, SUBSCRIBE_FAILURE_REPLY);
    } catch {
      // 吞掉兜底发送失败，不重试（防递归）。
    }
  }
}

/**
 * 「退订」handler（精确匹配）：
 * - 写 active=false（仅此字段；GitHub 绑定与收藏原样保留）→ 中文确认
 * - digest.ts 的 pushDigests 固化 WHERE active = true，退订即停止每日简报
 */
export async function handleUnsubscribe(msg: InboundMessage): Promise<void> {
  try {
    if (msg.content.trim() !== '退订') {
      return;
    }
    await db()
      .update(subscribers)
      .set({ active: false })
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    await sendWeComText(msg.fromUserName, UNSUBSCRIBE_REPLY);
  } catch (err) {
    console.error('handleUnsubscribe failed:', err);
    try {
      await sendWeComText(msg.fromUserName, UNSUBSCRIBE_FAILURE_REPLY);
    } catch {
      // 吞掉兜底发送失败，不重试（防递归）。
    }
  }
}
