/**
 * 入站消息路由器：按 content / msgType 分发到注册的 handler。
 * Task 9（帮助）、12（收藏）、13（搜索、订阅开通与偏好）通过 registerHandlers
 * 挂接真实实现，无需修改本文件的分发逻辑。
 */

import {
  FAVORITE_USAGE_REPLY,
  handleFavorite,
  handleList,
  handleUnfavorite,
  UNFAVORITE_USAGE_REPLY,
} from '../github/stars.js';
import { bindHandler } from '../github/oauth.js';
import { handleInterested, handleNotInterested } from './feedback.js';
import {
  CLEAR_MODEL_USAGE_REPLY,
  MY_MODEL_USAGE_REPLY,
  SET_MODEL_USAGE_REPLY,
  handleClearModel,
  handleMyModel,
  handleSetModel,
} from './llm-settings.js';
import {
  ensureSubscriber,
  handleDigestCount,
  handleHelp,
  handlePushInterval,
  handlePushTime,
  handleSubscribe,
  handleUnsubscribe,
} from './onboarding.js';
import { sendWeComText } from './api.js';
import { handleSearch } from './reply.js';
import { MEMORY_USAGE_REPLY, handleMemoryCommand } from './memory.js';
import { decideTextRoute, normalizeCommandText, type UsageKey } from './route-decision.js';
import { clearPending, interpretConfirmation, interpretKeyword, readPending } from '../agent/pending.js';
import { askSubscribeKeyword, handleKeywordReply, handlePendingReply } from './pending.js';
import {
  CANCEL_SUBSCRIPTION_USAGE_REPLY,
  MY_SUBSCRIPTION_USAGE_REPLY,
  handleCancelSubscriptionTerm,
  handleMySubscription,
} from './subscription.js';
import { sendWelcomeFlow } from './welcome.js';
import { handleMyPanel } from './panel-link.js';
import { handleTodayDigest } from './today-digest.js';
import {
  MY_TRACKING_EMPTY_REPLY,
  TRACK_USAGE_REPLY,
  UNTRACK_USAGE_REPLY,
  handleMyTracking,
  handleTrack,
  handleUntrack,
} from './tracking-commands.js';
import { note, traceError, withTrace } from '../obs/trace.js';
import {
  RATE_LIMIT_REPLY,
  checkQuota,
  type QuotaDecision,
} from '../agent/rate-limit.js';

export interface InboundMessage {
  toUserName: string;
  fromUserName: string;
  createTime: number;
  msgType: string;
  content: string;
  msgId: string;
  /** 事件类型（MsgType=event 时有值，如 enter_agent）；普通消息为空串。 */
  event?: string;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void> | void;

export interface Handlers {
  help: MessageHandler;
  unfavorite: MessageHandler;
  favorite: MessageHandler;
  list: MessageHandler;
  /** 「感兴趣」——看完简报回一个词，作用于刚收到的那一批。 */
  interested: MessageHandler;
  /** 「不感兴趣」。 */
  notInterested: MessageHandler;
  search: MessageHandler;
  bind: MessageHandler;
  subscribe: MessageHandler;
  unsubscribe: MessageHandler;
  /** 「我的订阅」——只读展示当前设置。 */
  mySubscription: MessageHandler;
  /** 「记住 / 忘掉 / 我的记忆」。 */
  memory: MessageHandler;
  /** 「取消订阅 <关键词>」——只删一个订阅词，不动 active。 */
  cancelSubscription: MessageHandler;
  digestCount: MessageHandler;
  pushTime: MessageHandler;
  pushInterval: MessageHandler;
  setModel: MessageHandler;
  myModel: MessageHandler;
  clearModel: MessageHandler;
  /** 「追踪 owner/repo」——关注仓库的 release / star 变化。 */
  track: MessageHandler;
  untrack: MessageHandler;
  myTracking: MessageHandler;
  /** 「我的面板」——发一条 7 天有效的控制面板链接。 */
  panel: MessageHandler;
}

/** 未注册时的静默 stub。 */
const stub: MessageHandler = () => {};

let handlers: Handlers = {
  help: stub,
  unfavorite: stub,
  favorite: stub,
  list: stub,
  interested: stub,
  notInterested: stub,
  search: stub,
  bind: stub,
  subscribe: stub,
  unsubscribe: stub,
  mySubscription: stub,
  memory: stub,
  cancelSubscription: stub,
  digestCount: stub,
  pushTime: stub,
  pushInterval: stub,
  setModel: stub,
  myModel: stub,
  clearModel: stub,
  track: stub,
  untrack: stub,
  myTracking: stub,
  panel: stub,
};

/**
 * 注册（或覆盖）handler。传入部分字段即可，未传的保持原值/默认 stub。
 * Tasks 9/12/13 在各自入口调用一次以挂接真实实现。
 */
export function registerHandlers(partial: Partial<Handlers>): void {
  handlers = { ...handlers, ...partial };
}

/** 恢复默认 stub（测试隔离用）。 */
export function resetHandlers(): void {
  handlers = {
    help: stub,
    unfavorite: stub,
    favorite: stub,
    list: stub,
    interested: stub,
    notInterested: stub,
    search: stub,
    bind: stub,
    subscribe: stub,
    unsubscribe: stub,
    mySubscription: stub,
    memory: stub,
    cancelSubscription: stub,
    digestCount: stub,
    pushTime: stub,
    pushInterval: stub,
    setModel: stub,
    myModel: stub,
    clearModel: stub,
    track: stub,
    untrack: stub,
    myTracking: stub,
    panel: stub,
  };
}

/** 「我的收藏」带了多余内容时的用法提示。 */
export const LIST_USAGE_REPLY = '用法：直接回复「我的收藏」即可（无需参数）';

/** 「绑定」带了多余内容时的用法提示。 */
export const BIND_USAGE_REPLY = '用法：直接回复「绑定」即可（无需参数）';

/** 「退订」带了多余内容时的用法提示。 */
export const UNSUBSCRIBE_USAGE_REPLY = '用法：直接回复「退订」即可（无需参数）';

/**
 * 疑似命令键 → 用法提示文案。
 * 决策（「这是哪条疑似命令」）在 route-decision.ts，文案留在这里：
 * 评测只关心走了哪条路，改文案不该影响路由判定。
 */
const USAGE_REPLIES: Record<UsageKey, string> = {
  unfavorite: UNFAVORITE_USAGE_REPLY,
  favorite: FAVORITE_USAGE_REPLY,
  list: LIST_USAGE_REPLY,
  mySubscription: MY_SUBSCRIPTION_USAGE_REPLY,
  memory: MEMORY_USAGE_REPLY,
  cancelSubscription: CANCEL_SUBSCRIPTION_USAGE_REPLY,
  bind: BIND_USAGE_REPLY,
  unsubscribe: UNSUBSCRIBE_USAGE_REPLY,
  setModel: SET_MODEL_USAGE_REPLY,
  clearModel: CLEAR_MODEL_USAGE_REPLY,
  myModel: MY_MODEL_USAGE_REPLY,
  track: TRACK_USAGE_REPLY,
  untrack: UNTRACK_USAGE_REPLY,
  myTracking: MY_TRACKING_EMPTY_REPLY,
};

/** 把 handler 调用包成 promise（同步抛错也转为 rejected promise）。 */
function dispatch(handler: MessageHandler, msg: InboundMessage): Promise<void> {
  return Promise.resolve().then(() => handler(msg));
}

/** handler 异常时给用户的兜底文案（每条入站消息最多一条）。 */
export const HANDLER_FAILURE_REPLY = '⚙️ 处理遇到问题，请稍后再试';

/**
 * 分发并兜底：handler 抛错（内层未吞掉的异常）→ 记日志 + 单次回发失败文案，
 * 让用户对失败有感知而非静默。兜底发送自身失败仅记日志——绝不重试、
 * 绝不重入分发（递归护栏，防止 兜底失败→再兜底 的无限循环）。
 * handler 成功（含内部已吞错者）不发兜底，故每条入站消息最多一条兜底。
 */
function dispatchSafely(
  handler: MessageHandler,
  msg: InboundMessage,
): Promise<void> {
  // 一处埋点覆盖全部命令分支：函数名就是路径名（handleHelp / handleSearch…）。
  note('handler', handler.name || 'anonymous');
  return dispatch(handler, msg).catch(async (err: unknown) => {
    console.error('handler failed:', err);
    traceError(err);
    try {
      await sendWeComText(msg.fromUserName, HANDLER_FAILURE_REPLY);
    } catch (fallbackErr) {
      console.error('fallback reply failed:', fallbackErr);
    }
  });
}

/**
 * enter_agent 事件（用户进入应用，含刚加入应用后的首次进入）：
 * 确保订阅者行存在；只有新用户才送礼包（欢迎 + 首日简报）。
 * 老用户每次进入都会触发该事件——绝不重复推送。
 * 与文本路径同样 fail-open：事件处理失败只记日志，不影响后续消息。
 */
async function handleEnterAgent(msg: InboundMessage): Promise<void> {
  try {
    const isNew = await ensureSubscriber(msg);
    if (isNew) {
      await sendWelcomeFlow(msg);
    }
  } catch (err) {
    console.error('enter_agent handling failed:', err);
    traceError(err);
  }
}

/**
 * 分发一条入站消息：
 * - event：仅 enter_agent（新用户礼包），其余事件静默忽略（返回 resolved promise）
 * - 非 text 非 event：静默忽略
 * - text 先 ensureSubscriber（首条消息自动开通订阅者行；新用户先送礼包
 *   （欢迎语 + 首日简报），再继续处理原消息 —— 简报写缓存必须先于原消息回复写缓存）
 * - 分发顺序：「帮助」→「取消收藏 N」→「收藏 N」→「我的收藏」「我的订阅」（精确）→
 *   「不感兴趣 …」→「感兴趣 …」（动词后须空白）→
 *   「绑定」（精确）→「订阅 …」（前缀）→「取消订阅 …」（动词后须空白）→「退订」（精确）→「条数 …」（前缀）→
 *   「每天 H 点/推送时间 …」「每 N 天」（锚定）→
 *   「设置模型」「我的模型」「清除模型」（精确）→
 *   疑似命令（以命令词开头却非合法指令 → 用法提示）→ 其余 text → search。
 *   精确匹配允许尾部中英文标点（「帮助。」「收藏 1！」）；「帮助」只精确匹配，
 *   「帮助我找 python」等长句仍走搜索。handler 异常由 dispatchSafely 捕获并
 *   单次回发兜底文案（routeMessage 实际不再 reject；回调端点的 catch 仅作第二道安全网）。
 */
/** 限流检查器：默认读 kv_cache；测试注入内存实现。 */
export type QuotaChecker = (userid: string) => Promise<QuotaDecision>;
let quotaChecker: QuotaChecker = (userid) => checkQuota(userid);
export function registerQuotaChecker(fn: QuotaChecker): void {
  quotaChecker = fn;
}
export function resetQuotaChecker(): void {
  quotaChecker = (userid) => checkQuota(userid);
}

/** 手动要今天简报的说法（精确匹配，避免把「每日推送设置」之类吞进来）。 */
const TODAY_DIGEST_COMMANDS = new Set([
  '每日推送',
  '今日推送',
  '今日简报',
  '今天的简报',
  '今天的推送',
]);

export async function routeMessage(msg: InboundMessage): Promise<void> {
  // 整个分发过程一条 trace：下游任意位置 note() 都挂到这次调用上。
  // 放在这里而不是各个 handler 里，是为了让「哪条命令」与「后续几步」在同一条记录里。
  return withTrace(
    {
      kind:
        msg.msgType === 'event'
          ? 'event'
          : msg.msgType === 'text'
            ? 'text'
            : 'other',
      userid: msg.fromUserName,
      text: msg.content,
    },
    () => routeMessageInner(msg),
  );
}

async function routeMessageInner(msg: InboundMessage): Promise<void> {
  // Task 6：enter_agent 是「加入即收到首日简报」的第二触发点（另一处是首条文本）。
  if (msg.msgType === 'event') {
    if (msg.event === 'enter_agent') {
      await handleEnterAgent(msg);
    }
    return;
  }
  if (msg.msgType !== 'text') {
    return;
  }

  // 按用户限流：分钟桶先判、日预算后记（见 rate-limit.ts）。超限只回固定文案，
  // 不分发 handler、不写 search_caches——「收藏 N」的序号因此不会被限流消息打乱。
  const quota = await quotaChecker(msg.fromUserName);
  if (!quota.allowed) {
    note('rate-limit', `${quota.reason ?? 'unknown'}:${quota.retryAfterSeconds}s`);
    return dispatchSafely(
      (m) => sendWeComText(m.fromUserName, RATE_LIMIT_REPLY),
      msg,
    );
  }

  // Task 13：首条消息自动开通；ensureSubscriber 内部 fail-open（DB 错误返回 false）。
  const isNew = await ensureSubscriber(msg);
  if (isNew) {
    try {
      // Task 6：礼包 = 欢迎语 + 首日简报；必须先于原消息回复（「收藏 N」缓存顺序）。
      await sendWelcomeFlow(msg);
    } catch (err) {
      // 礼包发送失败不阻塞原消息处理（fail-open）。
      console.warn('welcome flow failed:', err);
      note('welcome-failed', err instanceof Error ? err.message : String(err));
    }
  }

  // 统一剥除尾部中英文标点：「帮助。」「收藏 1！」与裸指令同等命中。
  // 分发时传归一化的副本——handler 会用各自的正则/等值再校验一次 content，
  // 若仍传原始文本，「收藏 1。」会在 router 命中后于 handler 静默掉（死消息）。
  const normalized: InboundMessage = {
    ...msg,
    content: normalizeCommandText(msg.content),
  };
  const decision = decideTextRoute(normalized.content);

  // 手动要今天简报：与每日推送同一个 news 渲染器，别再回一份纯文本列表。
  if (TODAY_DIGEST_COMMANDS.has(normalized.content)) {
    note('route', 'today-digest');
    return dispatchSafely(handleTodayDigest, normalized);
  }

  // 多轮状态只消费「整条消息就是待办要的那个答复」：系统刚问过「要我记住吗」
  // 或「想订阅什么」。任何别的内容（尤其是命令）都把 pending 清掉后按新消息
  // 处理——宁可漏掉一次确认，也不让上周的问题吞掉今天的搜索。
  const pending = await readPending(msg.fromUserName);
  if (pending !== null) {
    if (pending.kind === 'profile-suggestion') {
      const verdict = interpretConfirmation(normalized.content);
      if (verdict !== null) {
        note('pending-consumed', `${pending.kind}:${verdict}`);
        return dispatchSafely(
          (m) => handlePendingReply(m, pending, verdict),
          normalized,
        );
      }
    } else {
      // 「对/不」对订阅追问没有意义：当作新消息，不把「对」订阅成关键词。
      const term =
        decision.kind === 'handler' &&
        decision.handler === 'search' &&
        interpretConfirmation(normalized.content) === null
          ? interpretKeyword(normalized.content)
          : null;
      if (term !== null) {
        note('pending-consumed', `${pending.kind}:keyword`);
        return dispatchSafely((m) => handleKeywordReply(m, term), normalized);
      }
    }
    await clearPending(msg.fromUserName);
    note('pending-clear', 'superseded');
  }

  if (decision.kind === 'usage') {
    // 疑似命令容错：以命令词开头却不是合法指令 → 回用法提示，绝不静默掉进搜索。
    note('route', 'suspected-command');
    return dispatchSafely(
      (m) => sendWeComText(m.fromUserName, USAGE_REPLIES[decision.usage]),
      normalized,
    );
  }
  // 裸「订阅」不甩一行用法，而是追问一个槽（单槽、5 分钟）：比让用户猜格式
  // 更像对话，也真正用到多轮状态。完整命令仍走原 handler。
  if (
    decision.handler === 'subscribe' &&
    normalized.content === '订阅'
  ) {
    note('pending-set', 'subscribe-keyword');
    return dispatchSafely(askSubscribeKeyword, normalized);
  }
  return dispatchSafely(handlers[decision.handler], normalized);
}

// Task 9：帮助/搜索 handler、Task 11：绑定 handler、Task 12：收藏/取消收藏/我的收藏
// handler、Task 13：订阅/退订 handler、Task 5：推送时间/推送间隔 handler
// 默认挂接真实实现（测试可用 resetHandlers 恢复 stub）。
registerHandlers({
  help: handleHelp,
  search: handleSearch,
  bind: bindHandler,
  favorite: handleFavorite,
  unfavorite: handleUnfavorite,
  list: handleList,
  interested: handleInterested,
  notInterested: handleNotInterested,
  subscribe: handleSubscribe,
  unsubscribe: handleUnsubscribe,
  mySubscription: handleMySubscription,
  memory: handleMemoryCommand,
  cancelSubscription: handleCancelSubscriptionTerm,
  digestCount: handleDigestCount,
  pushTime: handlePushTime,
  pushInterval: handlePushInterval,
  setModel: handleSetModel,
  myModel: handleMyModel,
  clearModel: handleClearModel,
  track: handleTrack,
  untrack: handleUntrack,
  myTracking: handleMyTracking,
  panel: handleMyPanel,
});
