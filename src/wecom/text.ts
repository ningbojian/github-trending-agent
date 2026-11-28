/**
 * 兼容转发层：实现已移到 `src/shared/text.ts`。
 *
 * 保留这个文件是为了不打乱现有 import 与测试 mock；新代码请直接从 shared 引入。
 * 文本渲染是纯函数，agent 层（digest）也要用，放在 wecom 会形成依赖环。
 */
export {
  MAX_TEXT_BYTES,
  singleLine,
  repoUrl,
  formatEntryLine,
  type DisplayEntry,
} from '../shared/text.js';
