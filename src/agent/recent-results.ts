/**
 * 兼容转发层：实现已移到 `src/db/recent-results.ts`。
 *
 * 保留这个文件是为了不打乱现有 import 与测试 mock；新代码请直接从 db 引入。
 * 它只是一次 search_caches 只读查询，放 db 层名正言顺——
 * github 层的「收藏 N」要用它，从 agent 层引入会形成依赖环。
 */
export { loadRecentResults, type RecentResultItem } from '../db/recent-results.js';
