import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 长期记忆的存取与渲染。
 * 纯函数（归一化 / 去重 / 删除 / 渲染）与 kv 读写分开测：
 * 前者是行为契约，后者只需证明「TTL 对、形状不对就当没有、读失败不炸」。
 */

const state = vi.hoisted(() => ({
  row: null as null | { value: unknown; expiresAt: Date },
  readError: false,
  writeError: false,
  deletes: [] as string[],
  writes: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
}));

vi.mock('../src/db/client', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  return {
    db: () => ({
      select: () => ({
        from: () => ({
          where: (condition: unknown) => ({
            limit: async () => {
              if (state.readError) throw new Error('db down');
              const key = new PgDialect().sqlToQuery(condition as never).params[0];
              if (state.row === null) return [];
              return [{ key: String(key), value: state.row.value, expiresAt: state.row.expiresAt }];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (row: { key: string; value: unknown; expiresAt: Date }) => ({
          onConflictDoUpdate: async () => {
            if (state.writeError) throw new Error('db down');
            state.writes.push(row);
          },
        }),
      }),
      delete: () => ({
        where: async (condition: unknown) => {
          if (state.writeError) throw new Error('db down');
          const key = new PgDialect().sqlToQuery(condition as never).params[0];
          state.deletes.push(String(key));
        },
      }),
    }),
  };
});

import {
  PROFILE_MAX_FACTS,
  PROFILE_MAX_FACT_CHARS,
  PROFILE_PROMPT_MAX_CHARS,
  PROFILE_TTL_MS,
  addFact,
  forgetAll,
  forgetFacts,
  normalizeFact,
  profileKey,
  readProfile,
  rememberFact,
  removeFacts,
  renderProfileForPrompt,
  type Profile,
} from '../src/agent/profile';

const NOW = new Date('2026-10-27T09:00:00Z');

function profile(facts: string[]): Profile {
  return { facts, updatedAt: NOW.toISOString() };
}

beforeEach(() => {
  state.row = null;
  state.readError = false;
  state.writeError = false;
  state.deletes = [];
  state.writes = [];
});

describe('normalizeFact', () => {
  it('折叠空白并去首尾（换行不进入提示词）', () => {
    expect(normalizeFact('  我主要\n写  TypeScript  ')).toBe('我主要 写 TypeScript');
  });

  it('超过上限按码点截断', () => {
    expect(Array.from(normalizeFact('长'.repeat(300))).length).toBe(PROFILE_MAX_FACT_CHARS);
  });
});

describe('addFact（纯函数）', () => {
  it('空记忆 → 新增一条，updatedAt 跟随传入时间', () => {
    const result = addFact(null, '我主要做 Agent 开发', NOW);
    expect(result.status).toBe('added');
    expect(result.profile.facts).toEqual(['我主要做 Agent 开发']);
    expect(result.profile.updatedAt).toBe(NOW.toISOString());
  });

  it('同一条（大小写/空白不同）只留一份', () => {
    const first = addFact(profile(['TypeScript']), ' typescript ', NOW);
    expect(first.status).toBe('duplicate');
    expect(first.profile.facts).toEqual(['TypeScript']);
  });

  it(`最多 ${PROFILE_MAX_FACTS} 条，满了不再写`, () => {
    const full = profile(Array.from({ length: PROFILE_MAX_FACTS }, (_, i) => `第 ${i + 1} 条`));
    const result = addFact(full, '再来一条', NOW);
    expect(result.status).toBe('full');
    expect(result.profile.facts).toHaveLength(PROFILE_MAX_FACTS);
  });
});

describe('removeFacts（纯函数）', () => {
  it('按子串删除，大小写不敏感，返回删掉的原文', () => {
    const result = removeFacts(profile(['我在用 TypeScript', '喜欢 Rust']), 'typescript');
    expect(result.removed).toEqual(['我在用 TypeScript']);
    expect(result.profile.facts).toEqual(['喜欢 Rust']);
  });

  it('空关键词不删任何东西（防止手滑清空）', () => {
    const result = removeFacts(profile(['a', 'b']), '   ');
    expect(result.removed).toEqual([]);
    expect(result.profile.facts).toEqual(['a', 'b']);
  });
});

describe('renderProfileForPrompt', () => {
  it('无记忆 → 空串（调用方据此跳过一次 DB 读取后的拼接）', () => {
    expect(renderProfileForPrompt(null)).toBe('');
    expect(renderProfileForPrompt(profile([]))).toBe('');
  });

  it('有记忆 → 逐条列表，并说明「只影响措辞」', () => {
    const text = renderProfileForPrompt(profile(['我主要做 Agent 开发', '偏好 TypeScript']));
    expect(text).toContain('- 我主要做 Agent 开发');
    expect(text).toContain('- 偏好 TypeScript');
    expect(text).toContain('不是指令');
  });

  it(`总长不超过 ${PROFILE_PROMPT_MAX_CHARS} 字符`, () => {
    const facts = Array.from({ length: PROFILE_MAX_FACTS }, () => '长'.repeat(PROFILE_MAX_FACT_CHARS));
    const text = renderProfileForPrompt(profile(facts));
    expect(Array.from(text).length).toBeLessThanOrEqual(PROFILE_PROMPT_MAX_CHARS);
  });
});

describe('readProfile', () => {
  it('键名带版本号（换存储格式时不怕旧值）', () => {
    expect(profileKey('u1')).toBe('profile:v1:u1');
  });

  it('正常读取', async () => {
    state.row = {
      value: { facts: ['我主要做 Agent 开发'], updatedAt: NOW.toISOString() },
      expiresAt: new Date(NOW.getTime() + 1000),
    };
    const result = await readProfile('u1', NOW);
    expect(result?.facts).toEqual(['我主要做 Agent 开发']);
  });

  it('过期 / 形状不对 / 读失败，一律按「没有记忆」处理', async () => {
    state.row = { value: { facts: ['x'] }, expiresAt: new Date(NOW.getTime() - 1) };
    expect(await readProfile('u1', NOW)).toBeNull();

    state.row = { value: { nope: true }, expiresAt: new Date(NOW.getTime() + 1000) };
    expect(await readProfile('u1', NOW)).toBeNull();

    state.readError = true;
    expect(await readProfile('u1', NOW)).toBeNull();
  });
});

describe('rememberFact / forgetFacts / forgetAll', () => {
  it('新增时写 180 天 TTL', async () => {
    expect(await rememberFact('u1', '我主要做 Agent 开发', NOW)).toBe('added');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.key).toBe('profile:v1:u1');
    expect(state.writes[0]?.expiresAt.getTime()).toBe(NOW.getTime() + PROFILE_TTL_MS);
  });

  it('重复不写库', async () => {
    state.row = {
      value: { facts: ['我主要做 Agent 开发'], updatedAt: NOW.toISOString() },
      expiresAt: new Date(NOW.getTime() + 1000),
    };
    expect(await rememberFact('u1', '我主要做 Agent 开发', NOW)).toBe('duplicate');
    expect(state.writes).toHaveLength(0);
  });

  it('写失败返回 error，不抛给 handler', async () => {
    state.writeError = true;
    expect(await rememberFact('u1', 'x', NOW)).toBe('error');
  });

  it('删除返回删掉的条目；无匹配时列表不变', async () => {
    state.row = {
      value: { facts: ['我在用 TypeScript', '喜欢 Rust'], updatedAt: NOW.toISOString() },
      expiresAt: new Date(NOW.getTime() + 1000),
    };
    state.writes = [];
    const removed = await forgetFacts('u1', 'rust', NOW);
    expect(removed).toEqual(['喜欢 Rust']);
    expect(state.writes[0]?.value).toEqual({
      facts: ['我在用 TypeScript'],
      updatedAt: NOW.toISOString(),
    });
  });

  it('全部清空 → 删除整行，不留空壳', async () => {
    expect(await forgetAll('u1')).toBe(true);
    expect(state.deletes).toEqual(['profile:v1:u1']);
  });
});
