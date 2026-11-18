import { describe, expect, it } from 'vitest';
import {
  summarizeOpportunities,
  templateSummary,
} from '../src/opportunities/summarize';
import type { OpportunityItem } from '../src/opportunities/types';

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤：...',
    url: 'https://github.com/acme/agent/issues/12',
    language: 'typescript',
    topics: ['agent'],
    stars: 500,
    license: 'MIT',
    archived: false,
    pushedAt: '2026-11-10T00:00:00.000Z',
    labels: ['good first issue'],
    comments: 3,
    reactions: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    maintainerEngaged: true,
    assigned: false,
    linkedPr: false,
    score: 80,
    why: '模板 why',
    firstStep: '模板 firstStep',
    effort: '小',
    confidence: '中',
    evidence: [],
    ...overrides,
  };
}

const A = item();
const B = item({
  id: 'research:acme/agent#9',
  kind: 'research',
  issueNumber: 9,
  labels: ['RFC'],
  why: '研究模板 why',
  firstStep: '研究模板 firstStep',
});

describe('summarizeOpportunities', () => {
  it('解析合法 JSON，丢弃多余 ID，缺失走模板', async () => {
    let prompt = '';
    const map = await summarizeOpportunities([A, B], {
      generate: async (input) => {
        prompt = input;
        return JSON.stringify({
          items: [
            {
              id: A.id,
              why: '这个坑值得修，因为它影响 Windows 用户。',
              firstStep: '按复现步骤跑一遍，贴 log 并认领。',
              effort: '小',
              confidence: '高',
            },
            {
              id: 'contribute:other/repo#1',
              why: '多余',
              firstStep: '多余',
              effort: '小',
              confidence: '低',
            },
          ],
        });
      },
    });

    expect(map.get(A.id)).toMatchObject({
      why: '这个坑值得修，因为它影响 Windows 用户。',
      firstStep: '按复现步骤跑一遍，贴 log 并认领。',
      effort: '小',
      confidence: '高',
    });
    expect(map.get(B.id)).toEqual(templateSummary(B));
    expect(map.has('contribute:other/repo#1')).toBe(false);
    expect(prompt).toContain('不可信');
    expect(prompt).toContain(A.id);
  });

  it('JSON 非法 / 生成抛错 → 全部走模板', async () => {
    const invalid = await summarizeOpportunities([A], {
      generate: async () => 'not json',
    });
    expect(invalid.get(A.id)).toEqual(templateSummary(A));

    const failed = await summarizeOpportunities([A], {
      generate: async () => {
        throw new Error('llm down');
      },
    });
    expect(failed.get(A.id)).toEqual(templateSummary(A));
  });
});
