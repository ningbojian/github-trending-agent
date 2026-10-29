import { describe, expect, it } from 'vitest';
import {
  OBSERVATION_DESCRIPTION_MAX_BYTES,
  buildObservationArticle,
} from '../src/wecom/observation-card';
import type { DailyObservations } from '../src/agent/observation';

const OBS: DailyObservations = {
  date: '2026-10-29',
  dataDate: '2026-10-29',
  lines: [
    {
      kind: 'theme-shift',
      signature: 'theme:ai',
      claim: 'AI 工具继续升温，VoiceStudio 等 25 个项目在榜',
      evidence: ['debpalash/VoiceStudio', 'pbakaus/impeccable'],
    },
    {
      kind: 'source-shift',
      signature: 'src:hf',
      claim: 'HF 新模型 Qwen/Qwen3.8-27B 一天拿到 1.8 万 likes',
      evidence: ['Qwen/Qwen3.8-27B'],
    },
  ],
  message: '今日观察（10-29）\n1. ...',
};

describe('buildObservationArticle', () => {
  it('单篇卡片：品牌封面 + 今日观察标题 + 判断描述 + 跳转', () => {
    const article = buildObservationArticle(OBS, 'https://ghtrending.cyou');
    expect(article.title).toBe('👀 今日观察 · 10-29');
    expect(article.description).toContain('1. AI 工具继续升温');
    expect(article.description).toContain('2. HF 新模型');
    expect(article.url).toBe('https://github.com/trending');
    expect(article.picurl).toBe(
      'https://ghtrending.cyou/docs/assets/observation-cover.png',
    );
  });

  it('描述超过 512 字节（安全值 500）时整条丢弃，绝不截半句', () => {
    const long = {
      ...OBS,
      lines: Array.from({ length: 3 }, (_, index) => ({
        kind: 'theme-shift' as const,
        signature: `theme:${index}`,
        claim: `${index + 1}${'很长的判断'.repeat(30)}`,
        evidence: ['a/b'],
      })),
    };
    const article = buildObservationArticle(long, 'https://x.test');
    expect(Buffer.byteLength(article.description ?? '', 'utf8')).toBeLessThanOrEqual(
      OBSERVATION_DESCRIPTION_MAX_BYTES,
    );
    expect(article.description).not.toContain('3很长的判断');
  });

  it('没有站点根时不带图（本地/测试）', () => {
    expect(buildObservationArticle(OBS).picurl).toBeUndefined();
  });
});

describe('buildObservationArticle — 点击跳转', () => {
  it('可以指定面板链接，点卡片直接进入管理页', () => {
    expect(
      buildObservationArticle(OBS, 'https://x.test', 'https://x.test/api/panel?t=t').url,
    ).toBe('https://x.test/api/panel?t=t');
  });
});
