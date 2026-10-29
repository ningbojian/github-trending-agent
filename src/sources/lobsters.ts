import {
  fetchJson,
  metricsOf,
  type SourceAdapter,
  type SourceItemInput,
} from './types.js';

/** Lobsters：小而精的技术社区，hottest.json 直接给当天热门。 */

interface Story {
  short_id?: unknown;
  short_id_url?: unknown;
  title?: unknown;
  url?: unknown;
  score?: unknown;
  comment_count?: unknown;
  submitter_user?: unknown;
  tags?: unknown;
  description_plain?: unknown;
}

export const lobstersAdapter: SourceAdapter = {
  id: 'lobsters',
  label: 'Lobsters',
  async fetch(): Promise<SourceItemInput[]> {
    const data = await fetchJson('https://lobste.rs/hottest.json');
    if (!Array.isArray(data)) return [];

    const items: SourceItemInput[] = [];
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const story = raw as Story;
      const id = String(story.short_id ?? '').trim();
      const title = String(story.title ?? '').trim();
      if (id === '' || title === '') continue;
      const url =
        typeof story.url === 'string' && story.url !== ''
          ? story.url
          : String(story.short_id_url ?? `https://lobste.rs/s/${id}`);
      items.push({
        source: 'lobsters',
        sourceId: id,
        itemType: 'story',
        title,
        url,
        author:
          typeof story.submitter_user === 'string' ? story.submitter_user : null,
        description:
          typeof story.description_plain === 'string'
            ? story.description_plain.slice(0, 280)
            : null,
        topics: Array.isArray(story.tags) ? story.tags.map(String).slice(0, 10) : [],
        metrics: metricsOf(
          ['score', story.score],
          ['comments', story.comment_count],
        ),
      });
    }
    return items;
  },
};
