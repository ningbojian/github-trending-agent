/**
 * 兼容转发层：实现已移到 `src/shared/wecom-api.ts`。
 *
 * 保留这个文件是为了不打乱现有 import；新代码请直接从 shared 引入。
 * 原因：github 层的 handler 要发企微消息，若从 wecom 层 import 发送函数，
 * 会和 wecom → github 的 handler 调用形成环。发送能力下沉到 shared 后，
 * 双方都只向下依赖。
 */
export {
  resetAccessTokenCache,
  getWeComAccessToken,
  getWeComAccessTokenForSecret,
  postMessage,
  sendWeComNews,
  sendWeComText,
} from '../shared/wecom-api.js';
