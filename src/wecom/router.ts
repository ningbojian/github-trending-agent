/**
 * 入站消息路由器：按 content / msgType 分发到注册的 handler。
 * Task 9（帮助）、12（收藏）、13（搜索）通过 registerHandlers 挂接真实实现，
 * 无需修改本文件的分发逻辑。
 */

import { handleSearch } from './reply';

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
  favorite: MessageHandler;
  search: MessageHandler;
}

/** 未注册时的静默 stub（Task 5 阶段的默认行为）。 */
const stub: MessageHandler = () => {};

let handlers: Handlers = { help: stub, favorite: stub, search: stub };

/**
 * 注册（或覆盖）handler。传入部分字段即可，未传的保持原值/默认 stub。
 * Tasks 9/12/13 在各自入口调用一次以挂接真实实现。
 */
export function registerHandlers(partial: Partial<Handlers>): void {
  handlers = { ...handlers, ...partial };
}

/** 恢复默认 stub（测试隔离用）。 */
export function resetHandlers(): void {
  handlers = { help: stub, favorite: stub, search: stub };
}

/** 「收藏 <数字>」——支持有/无空格与多位数。 */
const FAVORITE_PATTERN = /^收藏\s*\d+$/;

/** 把 handler 调用包成 promise（同步抛错也转为 rejected promise）。 */
function dispatch(handler: MessageHandler, msg: InboundMessage): Promise<void> {
  return Promise.resolve().then(() => handler(msg));
}

/**
 * 分发一条入站消息：
 * - 非 text 类型：静默忽略（返回 resolved promise）
 * - 「帮助」→ help；「收藏 N」→ favorite；其余 text → search
 * handler 抛错会以 rejected promise 传播，由调用方（回调端点）负责 catch。
 */
export function routeMessage(msg: InboundMessage): Promise<void> {
  if (msg.msgType !== 'text') {
    return Promise.resolve();
  }
  const content = msg.content.trim();
  if (content === '帮助') {
    return dispatch(handlers.help, msg);
  }
  if (FAVORITE_PATTERN.test(content)) {
    return dispatch(handlers.favorite, msg);
  }
  return dispatch(handlers.search, msg);
}

// Task 9：搜索 handler 默认挂接真实实现（测试可用 resetHandlers 恢复 stub）。
registerHandlers({ search: handleSearch });
