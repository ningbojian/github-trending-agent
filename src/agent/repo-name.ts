/**
 * 兼容转发层：实现已移到 `src/shared/repo-name.ts`。
 *
 * 保留这个文件是为了不打乱现有 import 与测试 mock；新代码请直接从 shared 引入。
 * 真正的原因见 shared 文件头注释——github 层要用这个函数，若从 agent 层引入
 * 就会形成 `github → agent → github` 的依赖环。
 */
export {
  normalizeRepoName,
  sameRepo,
  REPO_TOKEN_RE,
  isRepoToken,
} from '../shared/repo-name.js';
