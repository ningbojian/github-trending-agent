import { describe, expect, it } from 'vitest';
import {
  HOT_MIN_DELTA,
  HOT_MIN_RATE,
  HOT_TOP_N,
  NEWS_MAX_ARTICLES,
  buildNewsArticles,
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
    short: '极快 Python linter',
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
    expect(buildNewsArticles(entries(10))).toHaveLength(NEWS_MAX_ARTICLES);
  });

  it('不足 8 条时按实际条数发，不补空卡', () => {
    expect(buildNewsArticles(entries(3))).toHaveLength(3);
  });
});

describe('news 卡片图片', () => {
  it('第 1 篇用 GitHub OG 宽图', () => {
    const [first] = buildNewsArticles(entries(3));
    expect(first.picurl).toBe('https://opengraph.githubassets.com/1/owner0/repo0');
  });

  it('给了站点根时，第 2 篇起用自托管 owner 头像；未知 owner 回退品牌图标', () => {
    const articles = buildNewsArticles(
      [
        entry({ fullName: 'astral-sh/ruff' }),
        entry({ fullName: 'hmjz100/LinkSwift' }),
        entry({ fullName: 'unknown-owner/repo' }),
      ],
      { baseUrl: 'https://ghtrending.cyou' },
    );
    expect(articles[1].picurl).toBe('https://ghtrending.cyou/docs/avatars/hmjz100.png');
    expect(articles[2].picurl).toBe('https://ghtrending.cyou/docs/assets/icon-750.png');
  });

  it('没有站点根时不发图（测试/本地）', () => {
    const articles = buildNewsArticles(entries(3));
    expect(articles[1].picurl).toBeUndefined();
    expect(articles[2].picurl).toBeUndefined();
  });
});

describe('news 卡片标题', () => {
  it('标题不超过企微的 128 字节上限', () => {
    for (const article of buildNewsArticles(entries(8))) {
      expect(Buffer.byteLength(article.title, 'utf8')).toBeLessThanOrEqual(128);
    }
  });

  it('超长仓库名也能收进 128 字节，且不拆坏多字节字符', () => {
    const longName = `${'a'.repeat(39)}/${'b'.repeat(100)}`;
    const [article] = buildNewsArticles([entry({ fullName: longName })]);
    expect(Buffer.byteLength(article.title, 'utf8')).toBeLessThanOrEqual(128);
    expect(article.title.endsWith('…')).toBe(true);
  });

  it('🔥 按增长率而不是绝对增量——基量小的暴涨项目也能亮', () => {
    const articles = buildNewsArticles(
      [
        // 增量最大，但基量大、增长率只有 2%。
        entry({ fullName: 'big/steady', stars: 50000, starsDelta: 1000 }),
        // 增量不是最大，但一周涨了 20%。
        entry({ fullName: 'small/hot', stars: 2000, starsDelta: 400 }),
        // 一周涨 6%，也过线。
        entry({ fullName: 'mid/hot', stars: 10000, starsDelta: 600 }),
      ],
    );

    expect(articles[0].title.startsWith('🔥')).toBe(false);
    expect(articles[1].title.startsWith('🔥 ')).toBe(true);
    expect(articles[2].title.startsWith('🔥 ')).toBe(true);
    expect(HOT_MIN_RATE).toBeGreaterThan(0);
  });

  it('火苗最多 2 个，按增长率取前二', () => {
    const articles = buildNewsArticles(
      [
        entry({ fullName: 'a/one', stars: 1000, starsDelta: 300 }), // 30%
        entry({ fullName: 'a/two', stars: 1000, starsDelta: 200 }), // 20%
        entry({ fullName: 'a/three', stars: 1000, starsDelta: 100 }), // 10%
      ],
    );

    expect(articles[0].title.startsWith('🔥 ')).toBe(true);
    expect(articles[1].title.startsWith('🔥 ')).toBe(true);
    expect(articles[2].title.startsWith('🔥')).toBe(false);
    expect(HOT_TOP_N).toBe(2);
  });

  it('增量太小（低于绝对下限）时，增长率再高也不给火苗', () => {
    const [article] = buildNewsArticles(
      [entry({ stars: 10, starsDelta: HOT_MIN_DELTA - 1 })],
    );
    expect(article.title.startsWith('🔥')).toBe(false);
  });

  it('新上榜用 🆕，不与 🔥 叠加', () => {
    const [article] = buildNewsArticles(
      [entry({ stars: 41200, starsDelta: 320, isNew: true })],
    );
    expect(article.title.startsWith('🆕 ')).toBe(true);
    expect(article.title).not.toContain('🔥');
  });

  it('标题不显示语言标签——把空间留给短简介，仓库名与星标后直接接简介', () => {
    const title = buildNewsArticles([entry()])[0].title;
    expect(title).toBe('1. astral-sh/ruff ★41.2k (+320)｜极快 Python linter');
    expect(title).not.toContain('· Rust');
  });

  it('没有短句时退回完整分句，绝不加省略号截半句', () => {
    const [article] = buildNewsArticles(
      [
        entry({
          short: undefined,
          summary: '极快的 Python linter，替代 flake8 与 isort',
        }),
      ],
    );
    expect(article.title).toBe(
      '1. astral-sh/ruff ★41.2k (+320)｜极快的 Python linter',
    );
  });

  it('连完整分句都太长时宁可不写简介，也不给半句', () => {
    const [article] = buildNewsArticles(
      [
        entry({
          short: undefined,
          summary: '一段没有标点而且非常非常长的中文简介文字内容',
        }),
      ],
    );
    expect(article.title).not.toContain('｜');
  });

  it('没有语言或简介时不留孤零零的分隔符', () => {
    const title = buildNewsArticles(
      [entry({ language: null, summary: undefined, short: undefined })],
    )[0].title;
    expect(title).toBe('1. astral-sh/ruff ★41.2k (+320)');
  });
});

