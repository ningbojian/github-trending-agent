/**
 * 工具路由观察器。
 *
 * Phase 2 之前没有工具层，这里明确返回 skipped——**不抛**，
 * 让 Phase 1 的 run 能在 tools.jsonl 已存在的情况下照常跑完。
 * Phase 2 落地后把实现换成真实的 `routeToTools`，评测用例无需改动。
 */
export interface ToolsObservation {
  skipped: boolean;
  route?: 'tools' | 'search' | 'parse';
  tool?: string;
}

export function observeToolRoute(_text: string): ToolsObservation {
  return { skipped: true };
}
