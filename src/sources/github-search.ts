import {
  fetchJson,
  metricsOf,
  type SourceAdapter,
  type SourceItemInput,
} from './types.js';

/**
 * GitHub Search：最近 7 天创建、star > 100 的新仓库，按 star 降序。
 *
 * 和 Trending 榜单的区别：Trending 是「正在热」，Search 能更早看到「刚冒头」，
 * 也能覆盖 Trending 没有的语言/话题。与 Trending 的重叠在观察层按 fullName 去重。
 * Search API 有独立限流（认证 30 次/分钟；未认证 10 次/分钟），每天只发一次查询。
 */

interface SearchItem {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  topics?: unknown;
  stargazers_count?: unknown;
  forks_count?: unknown;
  owner?: { login?: unknown };
}

export const githubSearchAdapter: SourceAdapter = {
  id: 'github_search',
  label: 'GitHub 新仓库',
  async fetch(now: Date): Promise<SourceItemInput[]> {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const query = `created:>${since} stars:>100`;
    const url =
      'https://api.github.com/search/repositories' +
      `?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=20`;
    const token = process.env.GITHUB_TOKEN?.trim();
    const data = await fetchJson(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

    const rows = (data as { items?: unknown } | null)?.items;
    if (!Array.isArray(rows)) return [];
    const items: SourceItemInput[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as SearchItem;
      const fullName = String(row.full_name ?? '').trim();
      if (fullName === '') continue;
      items.push({
        source: 'github_search',
        sourceId: fullName.toLowerCase(),
        itemType: 'repo',
        title: fullName,
        url: String(row.html_url ?? `https://github.com/${fullName}`),
        author:
          typeof row.owner?.login === 'string' ? row.owner.login : null,
        description:
          typeof row.description === 'string' ? row.description : null,
        topics: Array.isArray(row.topics) ? row.topics.map(String).slice(0, 10) : [],
        metrics: metricsOf(
          ['stars', row.stargazers_count],
          ['forks', row.forks_count],
        ),
      });
    }
    return items;
  },
};
