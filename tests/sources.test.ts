import { describe, expect, it, vi } from 'vitest';

/**
 * 多源适配器：只验证「API 字段 → 统一条目」的映射与源隔离。
 * 全部 stub 全局 fetch，不触网。
 */

const dbMock = vi.hoisted(() => ({
  inserted: [] as unknown[],
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    insert: () => ({
      values: (rows: unknown) => {
        dbMock.inserted.push(rows);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  }),
}));

import { githubSearchAdapter } from '../src/sources/github-search';
import { hackerNewsAdapter } from '../src/sources/hackernews';
import { hfModelsAdapter } from '../src/sources/hf';
import { lobstersAdapter } from '../src/sources/lobsters';
import { runSources } from '../src/sources/run-sources';
import type { SourceAdapter } from '../src/sources/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Hugging Face', () => {
  it('模型列表映射成统一条目，保留 downloads/likes 与 tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          {
            id: 'Qwen/Qwen3-8B',
            author: 'Qwen',
            downloads: 120000,
            likes: 900,
            tags: ['text-generation', 'transformers'],
            pipeline_tag: 'text-generation',
          },
        ]),
      ),
    );

    const items = await hfModelsAdapter.fetch(new Date());

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'hf_models',
      sourceId: 'Qwen/Qwen3-8B',
      itemType: 'model',
      url: 'https://huggingface.co/Qwen/Qwen3-8B',
      metrics: { downloads: 120000, likes: 900 },
      topics: ['text-generation', 'transformers'],
    });
  });
});

describe('GitHub Search', () => {
  it('按 7 天窗口查询，映射仓库字段；有 token 时带 Authorization', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'gh-token';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({
        items: [
          {
            full_name: 'acme/rocket',
            html_url: 'https://github.com/acme/rocket',
            description: 'fast tool',
            topics: ['cli', 'rust'],
            stargazers_count: 1234,
            forks_count: 56,
            owner: { login: 'acme' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const items = await githubSearchAdapter.fetch(new Date('2026-10-29T01:00:00Z'));

    expect(items[0]).toMatchObject({
      source: 'github_search',
      sourceId: 'acme/rocket',
      itemType: 'repo',
      metrics: { stars: 1234, forks: 56 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('created%3A%3E2026-10-22');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer gh-token',
    );
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
});

describe('Hacker News', () => {
  it('没有外链时回退到讨论页，保留 points/comments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          hits: [
            {
              objectID: '123',
              title: 'Ask HN: something',
              url: null,
              points: 210,
              num_comments: 88,
              author: 'alice',
              story_text: 'hello',
            },
          ],
        }),
      ),
    );

    const items = await hackerNewsAdapter.fetch(new Date());

    expect(items[0]).toMatchObject({
      source: 'hackernews',
      sourceId: '123',
      url: 'https://news.ycombinator.com/item?id=123',
      metrics: { points: 210, comments: 88 },
    });
  });
});

describe('Lobsters', () => {
  it('映射分数、评论数与 tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          {
            short_id: 'abc',
            short_id_url: 'https://lobste.rs/s/abc',
            title: 'A story',
            url: 'https://example.com/story',
            score: 42,
            comment_count: 7,
            submitter_user: 'bob',
            tags: ['rust'],
            description_plain: '',
          },
        ]),
      ),
    );

    const items = await lobstersAdapter.fetch(new Date());

    expect(items[0]).toMatchObject({
      source: 'lobsters',
      sourceId: 'abc',
      url: 'https://example.com/story',
      metrics: { score: 42, comments: 7 },
      topics: ['rust'],
    });
  });
});

describe('runSources', () => {
  it('单源失败不影响其他源；成功源写入库', async () => {
    dbMock.inserted.length = 0;
    const good: SourceAdapter = {
      id: 'good',
      label: 'Good',
      fetch: async () => [
        {
          source: 'good',
          sourceId: 'a',
          itemType: 'story',
          title: 'A',
          url: 'https://example.com/a',
        },
      ],
    };
    const bad: SourceAdapter = {
      id: 'bad',
      label: 'Bad',
      fetch: async () => {
        throw new Error('blocked');
      },
    };

    const results = await runSources(new Date('2026-10-29T01:00:00Z'), [good, bad]);

    expect(results).toEqual([
      { id: 'good', label: 'Good', count: 1 },
      { id: 'bad', label: 'Bad', count: 0, error: 'blocked' },
    ]);
    expect(dbMock.inserted).toHaveLength(1);
  });
});
