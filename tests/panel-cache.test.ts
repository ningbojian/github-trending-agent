import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_CACHE_TTL_MS,
  bumpPanelDirty,
  readPanelDirty,
  readPanelHtml,
  writePanelHtml,
} from '../src/panel/cache';

const dbMock = vi.hoisted(() => ({
  selectRows: [] as Array<{ value: unknown; expiresAt: Date | null }>,
  inserted: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
  failSelect: false,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (dbMock.failSelect) throw new Error('db down');
          return [...dbMock.selectRows];
        },
      }),
    }),
    insert: () => ({
      values: (values: { key: string; value: unknown; expiresAt: Date }) => ({
        onConflictDoUpdate: async () => {
          dbMock.inserted.push(values);
        },
      }),
    }),
  }),
}));

beforeEach(() => {
  dbMock.selectRows.length = 0;
  dbMock.inserted.length = 0;
  dbMock.failSelect = false;
});

const NOW = new Date('2026-10-30T08:00:00.000Z');

describe('panel cache', () => {
  it('命中：返回未过期的 HTML', async () => {
    dbMock.selectRows.push({
      value: { html: '<p>cached</p>' },
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    await expect(readPanelHtml('alice', 1, 'overview', '', NOW)).resolves.toBe(
      '<p>cached</p>',
    );
  });

  it('过期或形状不对：返回 null', async () => {
    dbMock.selectRows.push({
      value: { html: '<p>old</p>' },
      expiresAt: new Date(NOW.getTime() - 1),
    });
    await expect(readPanelHtml('alice', 1, 'overview', '', NOW)).resolves.toBeNull();

    dbMock.selectRows.length = 0;
    dbMock.selectRows.push({ value: { nope: 1 }, expiresAt: new Date(NOW.getTime() + 1000) });
    await expect(readPanelHtml('alice', 1, 'overview', '', NOW)).resolves.toBeNull();
  });

  it('写入带 30 秒 TTL', async () => {
    await writePanelHtml('alice', 2, 'tracking', 'd1', '<p>x</p>', NOW);
    expect(dbMock.inserted).toHaveLength(1);
    expect(dbMock.inserted[0]!.key).toContain('panel-html:v1:alice:2:d1:tracking');
    expect(dbMock.inserted[0]!.expiresAt.getTime()).toBe(
      NOW.getTime() + PANEL_CACHE_TTL_MS,
    );
  });

  it('dirty 标记：读不到当空串；bump 后键变化', async () => {
    await expect(readPanelDirty('alice')).resolves.toBe('');
    dbMock.selectRows.push({
      value: { at: '2026-10-30T08:00:00.000Z' },
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    await expect(readPanelDirty('alice')).resolves.toBe('2026-10-30T08:00:00.000Z');

    await bumpPanelDirty('alice', NOW);
    expect(dbMock.inserted[0]!.key).toBe('panel-dirty:v1:alice');
  });

  it('存储异常 → fail-open（读拿 null、dirty 空串）', async () => {
    dbMock.failSelect = true;
    await expect(readPanelHtml('alice', 1, 'overview', '', NOW)).resolves.toBeNull();
    await expect(readPanelDirty('alice')).resolves.toBe('');
  });
});
