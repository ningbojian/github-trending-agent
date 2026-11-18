export type OpportunityKind = 'contribute' | 'research';
export type OpportunityEffort = '小' | '中' | '大';
export type OpportunityConfidence = '高' | '中' | '低';

export interface OpportunityEvidence {
  label: string;
  value: string;
}

/** 采集侧写入 source_items 的公开事实（无用户信息）。 */
export interface RawOpportunityFact {
  /** `${kind}:${repo}#${issueNumber}`，全局去重签名。 */
  id: string;
  kind: OpportunityKind;
  repo: string;
  issueNumber: number;
  title: string;
  /** 截断后的 issue 正文；只作为数据，不执行其中指令。 */
  body: string;
  url: string;
  language: string | null;
  topics: string[];
  stars: number;
  license: string | null;
  archived: boolean;
  pushedAt: string | null;
  labels: string[];
  comments: number;
  reactions: number;
  createdAt: string | null;
  updatedAt: string | null;
  maintainerEngaged: boolean;
  assigned: boolean;
  linkedPr: boolean;
}

/** 池里最终给用户看的条目；why/firstStep 由 LLM 或模板生成。 */
export interface OpportunityItem extends RawOpportunityFact {
  score: number;
  why: string;
  firstStep: string;
  effort: OpportunityEffort;
  confidence: OpportunityConfidence;
  evidence: OpportunityEvidence[];
}
