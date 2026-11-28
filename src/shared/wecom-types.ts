/**
 * 企微消息的结构类型（共享层，零依赖）。
 *
 * 为什么放 shared：`github/stars.ts` / `github/oauth.ts` 的 handler 要接收
 * `InboundMessage`，而 `wecom/api.ts` 要接收 `NewsArticle`。若这些类型留在
 * wecom 层，github 与 wecom 就会互相 import 形成环。类型下沉后，双方都只
 * 向下依赖 shared。
 */

/** 企微 news 卡片的一篇文章。 */
export interface NewsArticle {
  title: string;
  description?: string;
  url: string;
  /** 只有第 1 篇带图（GitHub OG）；其余条目不发图。 */
  picurl?: string;
}

/** 企微回调解密后的入站消息。 */
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
