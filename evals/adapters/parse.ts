import { classifyByRules, type Intent } from '../../src/agent/intent.js';
import { parseSearchQuery, type SearchQuery } from '../../src/agent/parse-query.js';

/**
 * 解析观察器：复刻 handleSearch 的真实组合，但走**零依赖路径**。
 *
 * - `classifyByRules` 先判高置信意图（纯函数）；
 * - 规则拿不准时用 `{ kind: 'none' }` 调 parseSearchQuery —— 不碰模型、
 *   不碰缓存、不碰 DB，只跑 fallbackParse。
 *
 * 因此这套指标在 CI 里可复现，也不花一分钱。带 `--llm` 时才另跑模型评分。
 */
export interface ParseObservation {
  /** 规则层的原始结论（null = 拿不准）。 */
  ruleIntent: Intent | null;
  query: SearchQuery;
  /** 最终生效意图：规则命中则用规则，否则用解析结果。 */
  intent: Intent;
}

export async function observeParse(text: string): Promise<ParseObservation> {
  const ruleIntent = classifyByRules(text);
  const query = await parseSearchQuery(text, { kind: 'none' });
  return { ruleIntent, query, intent: ruleIntent ?? query.intent };
}
