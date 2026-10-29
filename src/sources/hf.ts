import {
  fetchJson,
  metricsOf,
  type SourceAdapter,
  type SourceItemInput,
} from './types.js';

/**
 * Hugging Face Hub：每日 trendingScore 的模型与 Space。
 *
 * 官方 JSON API，不需要页面解析。注意：Hugging Face 在部分网络环境下
 * 不可达（本机实测被墙），所以这个适配器要在 GitHub Actions runner 上跑；
 * 本地跑失败不影响其他源（run-sources 逐源隔离）。
 */

interface HfItem {
  id?: unknown;
  modelId?: unknown;
  author?: unknown;
  downloads?: unknown;
  likes?: unknown;
  tags?: unknown;
  pipeline_tag?: unknown;
}

function toItems(
  rows: unknown,
  itemType: 'model' | 'space',
  base: string,
): SourceItemInput[] {
  if (!Array.isArray(rows)) return [];
  const items: SourceItemInput[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as HfItem;
    const id = String(row.id ?? row.modelId ?? '').trim();
    if (id === '') continue;
    items.push({
      source: itemType === 'model' ? 'hf_models' : 'hf_spaces',
      sourceId: id,
      itemType,
      title: id,
      url: `${base}/${itemType === 'space' ? 'spaces/' : ''}${id}`,
      author: typeof row.author === 'string' ? row.author : null,
      description: typeof row.pipeline_tag === 'string' ? row.pipeline_tag : null,
      topics: Array.isArray(row.tags) ? row.tags.map(String).slice(0, 10) : [],
      metrics: metricsOf(['downloads', row.downloads], ['likes', row.likes]),
    });
  }
  return items;
}

async function fetchHf(
  path: 'models' | 'spaces',
  itemType: 'model' | 'space',
): Promise<SourceItemInput[]> {
  const data = await fetchJson(
    `https://huggingface.co/api/${path}?sort=trendingScore&direction=-1&limit=20`,
  );
  return toItems(data, itemType, 'https://huggingface.co');
}

export const hfModelsAdapter: SourceAdapter = {
  id: 'hf_models',
  label: 'Hugging Face 模型',
  fetch: async () => fetchHf('models', 'model'),
};

export const hfSpacesAdapter: SourceAdapter = {
  id: 'hf_spaces',
  label: 'Hugging Face Spaces',
  fetch: async () => fetchHf('spaces', 'space'),
};
