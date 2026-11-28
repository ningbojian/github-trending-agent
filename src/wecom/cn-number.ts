/**
 * 兼容转发层：实现已移到 `src/shared/cn-number.ts`。
 *
 * 保留这个文件是为了不打乱现有 import；新代码请直接从 shared 引入。
 * github/stars.ts 的「收藏 N」与 wecom 的路由共用这份数字解析，
 * 放在 wecom 层会让 github → wecom 形成依赖环。
 */
export {
  NUMBER_TOKEN_PATTERN,
  parseCnNumber,
  type ParseCnNumberOptions,
} from '../shared/cn-number.js';
