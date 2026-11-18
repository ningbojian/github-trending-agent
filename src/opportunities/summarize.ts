import type {
  OpportunityConfidence,
  OpportunityEffort,
  OpportunityItem,
} from './types.js';

export interface OpportunitySummary {
  id: string;
  why: string;
  firstStep: string;
  effort: OpportunityEffort;
  confidence: OpportunityConfidence;
}

/** LLM 不可用时的确定性文案：池永远有可展示内容。 */
export function templateSummary(item: OpportunityItem): OpportunitySummary {
  return {
    id: item.id,
    why: item.why,
    firstStep: item.firstStep,
    effort: item.effort,
    confidence: item.confidence,
  };
}

/**
 * 一次共享 LLM pass；实现见 Task 5。当前先返回模板，保证池构建可独立测试。
 */
export async function summarizeOpportunities(
  items: OpportunityItem[],
  _deps?: { generate?: (prompt: string) => Promise<string> },
): Promise<Map<string, OpportunitySummary>> {
  return new Map(items.map((item) => [item.id, templateSummary(item)]));
}
