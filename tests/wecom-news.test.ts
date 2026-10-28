import { describe, expect, it } from 'vitest';
import {
  HOT_DELTA,
  NEWS_MAX_ARTICLES,
  buildNewsArticles,
  shortSummary,
  type NewsEntry,
} from '../src/wecom/news';

/**
 * 企微 news 卡片的渲染规则。
 *
 * 这些约束不是审美，是实测出来的硬边界（2026-10-28，个人微信）：
 * - 一条 news 最多 8 篇（第 9 篇被企微以 45008 拒绝）；
 * - 多篇布局里只有标题可见，简介不显示；
 * - 标题在客户端约 10–12 个汉字处被裁，超出的部分用户永远看不到；
 * - 第 2 篇之后是方形缩略图，图片必须来自我们自己的域名（第三方图床
 *   会被企微随机丢弃，只剩灰头像）。
 */

const LONG_ZH = '用 Rust 写的极快 Python linter，替代 flake8 与 isort，并支持几乎所有编辑器';

function entry(overrides: Partial<NewsEntry> = {}): NewsEntry {
  return {
    fullName: 'astral-sh/ruff',
    stars: 41200,
    starsDelta: 320,
    isNew: false,
    language: 'Rust',
    summary: LONG_ZH,
    ...overrides,
  };
}

function entries(count: number): NewsEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry({
      fullName: `owner${i}/repo${i}`,
      stars: 12000 + i,
      starsDelta: 400 - i * 10,
    }),
  );
}

describe('news 卡片条数', () => {
  it(`一条 news 最多 ${NEWS_MAX_ARTICLES} 篇——第 9 篇会被企微以 45008 拒绝`, () => {
    expect(buildNewsArticles(entries(10), { baseUrl: 'https://ghtrending.cyou' })).toHaveLength(
      NEWS_MAX_ARTICLES,
    );
  });

  it('不足 8 条时按实际条数发，不补空卡', () => {
    expect(buildNewsArticles(entries(3), { baseUrl: 'https://ghtrending.cyou' })).toHaveLength(3);
  });
});

describe('news 卡片图片', () => {
  it('首篇用 GitHub OG 海报（多篇布局里它是唯一的大图）', () => {
    const [first] = buildNewsArticles(entries(3), { baseUrl: 'https://ghtrending.cyou' });
    expect(first.picurl).toBe('https://opengraph.githubassets.com/1/owner0/repo0');
  });

  it('其余用同一域名下的 /api/tile，绝不让企微直连 GitHub', () => {
    const articles = buildNewsArticles(entries(3), { baseUrl: 'https://ghtrending.cyou/' });
    expect(articles[1].picurl).toBe(
      'https://ghtrending.cyou/api/tile?repo=owner1%2Frepo1&lang=Rust',
    );
    expect(articles[2].picurl).toContain('https://ghtrending.cyou/api/tile');
  });
});

describe('news 卡片标题', () => {
  it('标题不超过企微的 128 字节上限', () => {
    for (const article of buildNewsArticles(entries(8), { baseUrl: 'https://ghtrending.cyou' })) {
      expect(Buffer.byteLength(article.title, 'utf8')).toBeLessThanOrEqual(128);
    }
  });

  it('超长仓库名也能收进 128 字节，且不拆坏多字节字符', () => {
    const longName = `${'a'.repeat(39)}/${'b'.repeat(100)}`;
    const [article] = buildNewsArticles([entry({ fullName: longName })], {
      baseUrl: 'https://ghtrending.cyou',
    });
    expect(Buffer.byteLength(article.title, 'utf8')).toBeLessThanOrEqual(128);
    expect(article.title.endsWith('…')).toBe(true);
  });

  it('🔥 只给增长够猛的项目，新上榜用 🆕', () => {
    const hot = buildNewsArticles([entry({ starsDelta: HOT_DELTA })], {
      baseUrl: 'https://x.test',
    })[0];
    const fresh = buildNewsArticles([entry({ starsDelta: HOT_DELTA - 1, isNew: true })], {
      baseUrl: 'https://x.test',
    })[0];
    const plain = buildNewsArticles([entry({ starsDelta: 1, isNew: false })], {
      baseUrl: 'https://x.test',
    })[0];

    expect(hot.title.startsWith('🔥 ')).toBe(true);
    expect(fresh.title.startsWith('🆕 ')).toBe(true);
    expect(plain.title.startsWith('🔥')).toBe(false);
    expect(plain.title.startsWith('🆕')).toBe(false);
  });

  it('语言标签跟星标后、简介前——尾部会被裁，仓库名必须最先可见', () => {
    const title = buildNewsArticles([entry()], { baseUrl: 'https://x.test' })[0].title;
    expect(title).toBe('🔥 1. astral-sh/ruff ★41.2k (+320) · Rust｜用 Rust 写的极快…');
  });

  it('没有语言或简介时不留孤零零的分隔符', () => {
    const title = buildNewsArticles([entry({ language: null, summary: undefined })], {
      baseUrl: 'https://x.test',
    })[0].title;
    expect(title).toBe('🔥 1. astral-sh/ruff ★41.2k (+320)');
  });
});

describe('短简介', () => {
  it('按显示宽度截断：一个汉字算两列，停在词/句边界', () => {
    expect(shortSummary(LONG_ZH)).toBe('用 Rust 写的极快…');
  });

  it('本来就短的原样返回，不加省略号', () => {
    expect(shortSummary('极快的 Python linter')).toBe('极快的 Python linter');
  });

  it('优先在中文标点处断开', () => {
    expect(shortSummary('大模型推理框架，支持 CPU 与显卡，零依赖')).toBe('大模型推理框架…');
  });

  it('空简介返回空串', () => {
    expect(shortSummary(undefined)).toBe('');
    expect(shortSummary('   ')).toBe('');
  });
});
