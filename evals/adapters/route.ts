import { decideTextRoute } from '../../src/wecom/route-decision.js';

/**
 * 路由观察器：直接调生产的纯决策函数，不启动分发链路。
 * 输出统一成 `handler:<name>` / `usage:<name>`，便于当混淆矩阵的标签。
 */
export interface RouteObservation {
  kind: 'handler' | 'usage';
  name: string;
  /** 用于比较/报告的稳定标签。 */
  label: string;
}

export function routeLabel(kind: 'handler' | 'usage', name: string): string {
  return `${kind}:${name}`;
}

export function observeRoute(text: string): RouteObservation {
  const decision = decideTextRoute(text);
  if (decision.kind === 'usage') {
    return { kind: 'usage', name: decision.usage, label: routeLabel('usage', decision.usage) };
  }
  return { kind: 'handler', name: decision.handler, label: routeLabel('handler', decision.handler) };
}
