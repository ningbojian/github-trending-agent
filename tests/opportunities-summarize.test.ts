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
              short: '修 Windows 检测',
              why: '这个坑值得修，因为它影响 Windows 用户。',
              firstStep: '按复现步骤跑一遍，贴 log 并认领。',
              effort: '小',
              confidence: '高',
            },
            {
              id: 'contribute:other/repo#1',
              short: '多余',
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
      short: '修 Windows 检测',
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

  it('超过一批时按批调用，单批失败只影响自己', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      item({
        id: `contribute:acme/repo#${index + 1}`,
        issueNumber: index + 1,
        repo: 'acme/repo',
        title: `问题 ${index + 1}`,
      }),
    );
    let calls = 0;
    const map = await summarizeOpportunities(many, {
      generate: async (prompt) => {
        calls += 1;
        if (prompt.includes('acme/repo#11')) throw new Error('second batch down');
        const ids = [...prompt.matchAll(/contribute:acme\/repo#\d+/g)].map(
          (match) => match[0],
        );
        return JSON.stringify({
          items: ids.map((id) => ({
            id,
            short: `修复问题 ${id.split('#')[1]}`,
            why: '值得修。',
            firstStep: '复现并认领。',
            effort: '小',
            confidence: '中',
          })),
        });
      },
    });

    expect(calls).toBeGreaterThan(1);
    expect(map.get(many[0]!.id)!.short).toBe('修复问题 1');
    expect(map.get(many[10]!.id)).toEqual(templateSummary(many[10]!));
    expect(map.get(many[11]!.id)).toEqual(templateSummary(many[11]!));
  });

  it('模板 short 去掉 [Tag]，直接用 issue 标题描述问题', () => {
    const tagged = item({
      short: undefined,
      title: '[Bug]: ag-ui-langgraph __init__ eagerly imports fastapi',
    });
    expect(templateSummary(tagged).short).toBe(
      'ag-ui-langgraph __init__ eagerly imports fastapi',
    );
  });

  it('空 why/firstStep 回退模板，长文本截到 80 字', async () => {
    const map = await summarizeOpportunities([A], {
      generate: async () =>
        JSON.stringify({
          items: [
            {
              id: A.id,
              short: '',
              why: '',
              firstStep: '   ',
              effort: '小',
              confidence: '高',
            },
          ],
        }),
    });
    expect(map.get(A.id)).toMatchObject({
      why: A.why,
      firstStep: A.firstStep,
      effort: '小',
      confidence: '高',
    });

    const long = await summarizeOpportunities([A], {
      generate: async () =>
        JSON.stringify({
          items: [
            {
              id: A.id,
              short: '短'.repeat(50),
              why: '很'.repeat(200),
              firstStep: '步'.repeat(200),
              effort: '小',
              confidence: '高',
            },
          ],
        }),
    });
    expect([...long.get(A.id)!.why].length).toBeLessThanOrEqual(80);
    expect([...long.get(A.id)!.firstStep].length).toBeLessThanOrEqual(80);
    expect([...long.get(A.id)!.short].length).toBeLessThanOrEqual(18);
  });
});
