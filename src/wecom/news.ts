/**
 * 兼容转发层：实现已移到 `src/shared/news.ts`。
 *
 * 保留这个文件是为了不打乱现有 import 与测试 mock；新代码请直接从 shared 引入。
 * news 卡片渲染是纯函数（无网络/DB），agent 层与 wecom 层都要用，
 * 放在 wecom 会让 agent → wecom 形成依赖环。
 */
export {
  NEWS_MAX_ARTICLES,
  HOT_TOP_N,
  HOT_MIN_DELTA,
  HOT_MIN_RATE,
  SHORT_SUMMARY_MAX_WIDTH,
  shortStars,
  deriveShort,
  buildNewsArticles,
  type NewsEntry,
  type BuildNewsOptions,
} from '../shared/news.js';
export type { NewsArticle } from '../shared/wecom-types.js';
