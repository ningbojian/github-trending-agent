import { describe, expect, it } from 'vitest';
import {
  buildOpportunityArticles,
  cleanIssueTitle,
  formatOpportunityCards,
  opportunityIssueLine,
  opportunityRepoLine,
  opportunityShort,
} from '../src/opportunities/format';
import type { OpportunityItem } from '../src/opportunities/types';

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: 'contribute:acme/agent#12',
    kind: 'contribute',
    repo: 'acme/agent',
    issueNumber: 12,
    title: 'Windows 下 CUDA 检测失败',
    body: '复现步骤...',
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
    short: '修 Windows 检测',
    repoDescription: 'agent toolkit',
    repoSummary: '智能体工具库',
    score: 80,
    why: '这个坑值得修。',
    firstStep: '按复现步骤跑一遍并认领。',
    effort: '小',
    confidence: '高',
    evidence: [],
    ...overrides,
  };
}

describe('cleanIssueTitle', () => {
  it('去掉 [Bug]/[RFC] 等标签，保留问题本身', () => {
    expect(
      cleanIssueTitle(
        '[Bug]: ag-ui-langgraph __init__ eagerly imports fastapi, breaking middleware-only (non-web) installs',
      ),
    ).toBe(
      'ag-ui-langgraph __init__ eagerly imports fastapi, breaking middleware-only (non-web) installs',
    );
    expect(cleanIssueTitle('[RFC] Observability component(s)')).toBe(
      'Observability component(s)',
    );
    expect(cleanIssueTitle('[Easy Money] ClickHouse 聚合性能')).toBe(
      'ClickHouse 聚合性能',
    );
  });

  it('去掉 proposal / tracking issue 等前缀，但不吞掉 D3D12 这类模块名', () => {
    expect(cleanIssueTitle('proposal: net/netip: add netip.Addr.To6()')).toBe(
      'net/netip: add netip.Addr.To6()',
    );
    expect(cleanIssueTitle('Tracking issue for RFC 92: Dynamic derivations')).toBe(
      'RFC 92: Dynamic derivations',
    );
    expect(
      cleanIssueTitle(
        'D3D12: SYSTEM_TIMESTAMP frequency for Write64BitValueBottomOfPipeX (info wanted)',
      ),
    ).toBe('D3D12: SYSTEM_TIMESTAMP frequency for Write64BitValueBottomOfPipeX (info wanted)');
  });

  it('不误删正文里的 Bug/RFC 单词（只有冒号前缀才剥）', () => {
    expect(cleanIssueTitle('Bug in parser when input is empty')).toBe(
      'Bug in parser when input is empty',
    );
    expect(cleanIssueTitle('RFC on async drop semantics')).toBe(
      'RFC on async drop semantics',
    );
  });
});

describe('opportunityShort', () => {
  it('没有模型短句时直接用清洗后的 issue 标题描述问题', () => {
    const tagged = item({
      short: undefined,
      title: '[Bug]: ag-ui-langgraph __init__ eagerly imports fastapi',
    });
    expect(opportunityShort(tagged)).toBe(
      'ag-ui-langgraph __init__ eagerly imports fastapi',
    );
  });

  it('旧池的英文碎片短句（[Bug]、D3D12）不展示，改用完整标题', () => {
    expect(
      opportunityShort(
        item({
          short: '[Bug]',
          title: '[Bug]: ag-ui-langgraph __init__ eagerly imports fastapi',
        }),
      ),
    ).toBe('ag-ui-langgraph __init__ eagerly imports fastapi');
    expect(
      opportunityShort(
        item({
          short: 'D3D12',
          title:
            'D3D12: SYSTEM_TIMESTAMP frequency for Write64BitValueBottomOfPipeX (info wanted)',
        }),
      ),
    ).toBe(
      'D3D12: SYSTEM_TIMESTAMP frequency for Write64BitValueBottomOfPipeX (info wanted)',
    );
  });

  it('标题为空时才退回泛化文案', () => {
    expect(
      opportunityShort(item({ short: undefined, title: '   ' })),
    ).toBe('可上手的 issue');
    expect(
      opportunityShort(
        item({ short: undefined, title: '', kind: 'research' }),
      ),
    ).toBe('开放问题');
  });
});

describe('opportunityRepoLine / opportunityIssueLine', () => {
  it('第一行优先用中文仓库简介，其次原始 description，最后仓库名', () => {
    expect(opportunityRepoLine(item())).toBe('智能体工具库');
    expect(
      opportunityRepoLine(item({ repoSummary: undefined })),
    ).toBe('agent toolkit');
    expect(
      opportunityRepoLine(
        item({ repoSummary: undefined, repoDescription: null }),
      ),
    ).toBe('acme/agent');
  });

  it('第二行描述 issue 要解决的问题，不带第一步', () => {
    expect(opportunityIssueLine(item())).toBe('修 Windows 检测');
    expect(opportunityIssueLine(item())).not.toContain('第一步');
  });
});

describe('机会卡片文案', () => {
  it('news 标题第一段是仓库描述，第二段才是 issue 问题', () => {
    const [article] = buildOpportunityArticles([item()]);
    expect(article!.title).toBe('智能体工具库｜修 Windows 检测');
    expect(article!.description).toContain('修 Windows 检测');
    expect(article!.description).not.toContain('第一步');
    expect(article!.title).not.toContain('填坑');
    expect(article!.title).not.toContain('研究');
  });

  it('文本卡片按「仓库描述 / issue 问题 / 仓库引用」排列，且不写第一步', () => {
    const [card] = formatOpportunityCards([item()]);
    const lines = card!.split('\n');
    expect(lines[0]).toBe('1. 智能体工具库');
    expect(lines[1]).toBe('修 Windows 检测');
    expect(lines[2]).toBe('acme/agent，issue 12');
    expect(card).not.toContain('第一步');
    expect(card).not.toContain('填坑：');
  });
});
