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
import { NUMBER_TOKEN_PATTERN } from './cn-number.js';
import {
  ensureSubscriber,
  handleDigestCount,
  handleHelp,
  handleSubscribe,
  handleUnsubscribe,
  WELCOME_MESSAGE,
} from './onboarding.js';
import { sendWeComText } from './api.js';
import { handleSearch } from './reply.js';

export interface InboundMessage {
  toUserName: string;
  fromUserName: string;
  createTime: number;
  msgType: string;
  content: string;
  msgId: string;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void> | void;

export interface Handlers {
  help: MessageHandler;
  unfavorite: MessageHandler;
  favorite: MessageHandler;
  list: MessageHandler;
  search: MessageHandler;
  bind: MessageHandler;
  subscribe: MessageHandler;
  unsubscribe: MessageHandler;
  digestCount: MessageHandler;
}

/** 未注册时的静默 stub（Task 5 阶段的默认行为）。 */
const stub: MessageHandler = () => {};

let handlers: Handlers = {
  help: stub,
  unfavorite: stub,
  favorite: stub,
  list: stub,
  search: stub,
  bind: stub,
  subscribe: stub,
  unsubscribe: stub,
  digestCount: stub,
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
    search: stub,
    bind: stub,
    subscribe: stub,
    unsubscribe: stub,
    digestCount: stub,
  };
}

/** 「取消收藏 <数字>」——支持有/无空格、阿拉伯/中文数字（须先于「收藏 N」判断）。 */
const UNFAVORITE_PATTERN = new RegExp(`^取消收藏\\s*${NUMBER_TOKEN_PATTERN}$`);

/** 「收藏 <数字>」——支持有/无空格、阿拉伯/中文数字。 */
const FAVORITE_PATTERN = new RegExp(`^收藏\\s*${NUMBER_TOKEN_PATTERN}$`);

/** 「订阅 …」——前缀匹配（「退订」首字为「退」，不会被吞掉）。 */
const SUBSCRIBE_PATTERN = /^订阅/;

/** 「条数 …」——前缀匹配（裸「条数」/非法输入由 handler 回用法提示）。 */
const DIGEST_COUNT_PATTERN = /^条数/;

/** 尾部中英文标点（精确/前缀分发与疑似命令判定前统一剥除，「帮助。」也能命中）。 */
const TRAILING_PUNCT_RE = /[。！？!?；;，,]+$/;

/** 「我的收藏」带了多余内容时的用法提示。 */
export const LIST_USAGE_REPLY = '用法：直接回复「我的收藏」即可（无需参数）';

/** 「绑定」带了多余内容时的用法提示。 */
export const BIND_USAGE_REPLY = '用法：直接回复「绑定」即可（无需参数）';

/** 「退订」带了多余内容时的用法提示。 */
export const UNSUBSCRIBE_USAGE_REPLY = '用法：直接回复「退订」即可（无需参数）';

/**
 * 疑似命令判定：精确/前缀分发全部未命中、即将 fallthrough 到搜索前，
 * 若内容以命令词开头却不是合法指令（如「收藏一下」「我的收藏列表」），
 * 回对应用法提示而不是把命令错字当搜索词发出去。
 * 「帮助」刻意不在列：长句（「帮助我找 python」）是合法的搜索请求，只精确匹配。
 */
function suspectedCommandUsage(content: string): string | null {
  if (content.startsWith('取消收藏')) {
    return UNFAVORITE_USAGE_REPLY;
  }
  if (content.startsWith('收藏')) {
    return FAVORITE_USAGE_REPLY;
  }
  if (content.startsWith('我的收藏')) {
    return LIST_USAGE_REPLY;
  }
  if (content.startsWith('绑定')) {
    return BIND_USAGE_REPLY;
  }
  if (content.startsWith('退订')) {
    return UNSUBSCRIBE_USAGE_REPLY;
  }
  return null;
}

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
  return dispatch(handler, msg).catch(async (err: unknown) => {
    console.error('handler failed:', err);
    try {
      await sendWeComText(msg.fromUserName, HANDLER_FAILURE_REPLY);
    } catch (fallbackErr) {
      console.error('fallback reply failed:', fallbackErr);
    }
  });
}

/**
 * 分发一条入站消息：
 * - 非 text 类型：静默忽略（返回 resolved promise）
 * - text 先 ensureSubscriber（首条消息自动开通订阅者行；新用户先收欢迎语，
 *   再继续处理原消息 —— 欢迎语与 handler 回复可能同时到达，欢迎语在前）
 * - 分发顺序：「帮助」→「取消收藏 N」→「收藏 N」→「我的收藏」（精确）→
 *   「绑定」（精确）→「订阅 …」（前缀）→「退订」（精确）→「条数 …」（前缀）→
 *   疑似命令（以命令词开头却非合法指令 → 用法提示）→ 其余 text → search。
 *   精确匹配允许尾部中英文标点（「帮助。」「收藏 1！」）；「帮助」只精确匹配，
 *   「帮助我找 python」等长句仍走搜索。handler 异常由 dispatchSafely 捕获并
 *   单次回发兜底文案（routeMessage 实际不再 reject；回调端点的 catch 仅作第二道安全网）。
 */
export async function routeMessage(msg: InboundMessage): Promise<void> {
  if (msg.msgType !== 'text') {
    return;
  }

  // Task 13：首条消息自动开通；ensureSubscriber 内部 fail-open（DB 错误返回 false）。
  const isNew = await ensureSubscriber(msg);
  if (isNew) {
    try {
      await sendWeComText(msg.fromUserName, WELCOME_MESSAGE);
    } catch (err) {
      // 欢迎语发送失败不阻塞原消息处理（fail-open）。
      console.warn('welcome send failed:', err);
    }
  }

  // 统一剥除尾部中英文标点：「帮助。」「收藏 1！」与裸指令同等命中。
  // 分发时传归一化的副本——handler 会用各自的正则/等值再校验一次 content，
  // 若仍传原始文本，「收藏 1。」会在 router 命中后于 handler 静默掉（死消息）。
  const normalized: InboundMessage = {
    ...msg,
    content: msg.content.trim().replace(TRAILING_PUNCT_RE, '').trim(),
  };
  const content = normalized.content;
  if (content === '帮助') {
    return dispatchSafely(handlers.help, normalized);
  }
  if (UNFAVORITE_PATTERN.test(content)) {
    return dispatchSafely(handlers.unfavorite, normalized);
  }
  if (FAVORITE_PATTERN.test(content)) {
    return dispatchSafely(handlers.favorite, normalized);
  }
  if (content === '我的收藏') {
    return dispatchSafely(handlers.list, normalized);
  }
  // Task 11：精确匹配「绑定」（trim 后），避免吞掉「绑定 XXX」类消息。
  if (content === '绑定') {
    return dispatchSafely(handlers.bind, normalized);
  }
  if (SUBSCRIBE_PATTERN.test(content)) {
    return dispatchSafely(handlers.subscribe, normalized);
  }
  if (content === '退订') {
    return dispatchSafely(handlers.unsubscribe, normalized);
  }
  if (DIGEST_COUNT_PATTERN.test(content)) {
    return dispatchSafely(handlers.digestCount, normalized);
  }
  // 疑似命令容错：以命令词开头却不是合法指令 → 回用法提示，绝不静默掉进搜索。
  const usage = suspectedCommandUsage(content);
  if (usage !== null) {
    return dispatchSafely(
      (m) => sendWeComText(m.fromUserName, usage),
      normalized,
    );
  }
  return dispatchSafely(handlers.search, normalized);
}

// Task 9：帮助/搜索 handler、Task 11：绑定 handler、Task 12：收藏/取消收藏/我的收藏
// handler、Task 13：订阅/退订 handler 默认挂接真实实现
// （测试可用 resetHandlers 恢复 stub）。
registerHandlers({
  help: handleHelp,
  search: handleSearch,
  bind: bindHandler,
  favorite: handleFavorite,
  unfavorite: handleUnfavorite,
  list: handleList,
  subscribe: handleSubscribe,
  unsubscribe: handleUnsubscribe,
  digestCount: handleDigestCount,
});
