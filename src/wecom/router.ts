/**
 * 入站消息路由器：按 content / msgType 分发到注册的 handler。
 * Task 9（帮助）、12（收藏）、13（搜索、订阅开通与偏好）通过 registerHandlers
 * 挂接真实实现，无需修改本文件的分发逻辑。
 */

import {
  handleFavorite,
  handleList,
  handleUnfavorite,
} from '../github/stars.js';
import { bindHandler } from '../github/oauth.js';
import {
  ensureSubscriber,
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
  };
}

/** 「取消收藏 <数字>」——支持有/无空格与多位数（须先于「收藏 N」判断）。 */
const UNFAVORITE_PATTERN = /^取消收藏\s*\d+$/;

/** 「收藏 <数字>」——支持有/无空格与多位数。 */
const FAVORITE_PATTERN = /^收藏\s*\d+$/;

/** 「订阅 …」——前缀匹配（「退订」首字为「退」，不会被吞掉）。 */
const SUBSCRIBE_PATTERN = /^订阅/;

/** 「退订」——精确匹配（与「绑定」「我的收藏」同一纪律）。 */
const UNSUBSCRIBE_PATTERN = /^退订$/;

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
 *   「绑定」（精确）→「订阅 …」（前缀）→「退订」（精确）→ 其余 text → search
 * handler 异常由 dispatchSafely 捕获并单次回发兜底文案（routeMessage 实际
 * 不再 reject；回调端点的 catch 仅作第二道安全网）。
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

  const content = msg.content.trim();
  if (content === '帮助') {
    return dispatchSafely(handlers.help, msg);
  }
  if (UNFAVORITE_PATTERN.test(content)) {
    return dispatchSafely(handlers.unfavorite, msg);
  }
  if (FAVORITE_PATTERN.test(content)) {
    return dispatchSafely(handlers.favorite, msg);
  }
  if (content === '我的收藏') {
    return dispatchSafely(handlers.list, msg);
  }
  // Task 11：精确匹配「绑定」（trim 后），避免吞掉「绑定 XXX」类消息。
  if (content === '绑定') {
    return dispatchSafely(handlers.bind, msg);
  }
  if (SUBSCRIBE_PATTERN.test(content)) {
    return dispatchSafely(handlers.subscribe, msg);
  }
  if (UNSUBSCRIBE_PATTERN.test(content)) {
    return dispatchSafely(handlers.unsubscribe, msg);
  }
  return dispatchSafely(handlers.search, msg);
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
});
