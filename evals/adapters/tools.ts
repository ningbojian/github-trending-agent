/**
 * 工具路由观察器：直接调生产用的规则前置 `routeToTools`。
 *
 * 评测关心两件事：这句话该不该进工具循环（route），以及进的话带的是哪个工具、
 * 哪个仓库（tool / args）。模型内部怎么走不在这里测——那是端到端真机的事，
 * CI 里没有网络也没有模型。
 */

import { routeToTools } from '../../src/wecom/tool-route';

export interface ToolsObservation {
  skipped: boolean;
  route?: 'tools' | 'search' | 'parse';
  tool?: string;
  args?: { repo: string | null };
}

export function observeToolRoute(text: string): ToolsObservation {
  const route = routeToTools(text);
  if (route.kind === 'tools') {
    return {
      skipped: false,
      route: 'tools',
      tool: route.tool,
      args: { repo: route.repo },
    };
  }
  return { skipped: false, route: 'search' };
}
