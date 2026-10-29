import {
  fetchJson,
  metricsOf,
  type SourceAdapter,
  type SourceItemInput,
} from './types.js';

/**
 * Hacker News：Algolia front_page（编辑精选首页）。
 * 只取首页而不是全站搜索，避免「高赞但没有讨论价值」的旧贴混进来。
 */

interface Hit {
  objectID?: unknown;
  title?: unknown;
  url?: unknown;
  points?: unknown;
  num_comments?: unknown;
  author?: unknown;
  story_text?: unknown;
}

export const hackerNewsAdapter: SourceAdapter = {
  id: 'hackernews',
  label: 'Hacker News',
  async fetch(): Promise<SourceItemInput[]> {
    const data = await fetchJson(
      'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20',
    );
    const hits = (data as { hits?: unknown } | null)?.hits;
    if (!Array.isArray(hits)) return [];

    const items: SourceItemInput[] = [];
    for (const raw of hits) {
      if (!raw || typeof raw !== 'object') continue;
      const hit = raw as Hit;
      const id = String(hit.objectID ?? '').trim();
      const title = String(hit.title ?? '').trim();
      if (id === '' || title === '') continue;
      const url =
        typeof hit.url === 'string' && hit.url !== ''
          ? hit.url
          : `https://news.ycombinator.com/item?id=${id}`;
      items.push({
        source: 'hackernews',
        sourceId: id,
        itemType: 'story',
        title,
        url,
        author: typeof hit.author === 'string' ? hit.author : null,
        description:
          typeof hit.story_text === 'string'
            ? hit.story_text.slice(0, 280)
            : null,
        topics: [],
        metrics: metricsOf(
          ['points', hit.points],
          ['comments', hit.num_comments],
        ),
      });
    }
    return items;
  },
};
