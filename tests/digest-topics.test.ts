import { describe, expect, it } from 'vitest';
import { selectEntriesForPreferences } from '../src/agent/digest-snapshot';

function item(fullName: string, topics: string[]) {
  return {
    fullName,
    description: null,
    topics,
    language: 'TypeScript',
    stars: 100,
    starsDelta: 50,
    isNew: false,
    htmlUrl: `https://github.com/${fullName}`,
    summary: '',
  };
}

const ITEMS = [
  item('acme/agent-kit', ['llm', 'agent']),
  item('acme/vision', ['vision']),
  item('acme/db', ['database']),
];

describe('selectEntriesForPreferences — 方向过滤', () => {
  it('只保留命中方向的项目', () => {
    const out = selectEntriesForPreferences(ITEMS, { topics: ['agent'] }, 8);
    expect(out.map((entry) => entry.fullName)).toEqual(['acme/agent-kit']);
  });

  it('多个方向取并集', () => {
    const out = selectEntriesForPreferences(
      ITEMS,
      { topics: ['agent', 'database'] },
      8,
    );
    expect(out.map((entry) => entry.fullName).sort()).toEqual([
      'acme/agent-kit',
      'acme/db',
    ]);
  });

  it('方向与语言同时生效', () => {
    const out = selectEntriesForPreferences(
      ITEMS,
      { topics: ['vision'], languages: ['python'] },
      8,
    );
    expect(out).toHaveLength(0);
  });

  it('全都命中不了时退回原列表（避免空简报）', () => {
    const out = selectEntriesForPreferences(ITEMS, { topics: ['quant'] }, 8);
    expect(out).toHaveLength(3);
  });
});
