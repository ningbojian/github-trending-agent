import { describe, expect, it } from 'vitest';

/**
 * 仓库名归一化：GitHub 的 owner/repo 大小写不敏感，但我们把它当字符串比较。
 * 把「比较时到底怎么归一」集中到一处，避免以后哪条路径漏一个小写化。
 */
import {
  isRepoToken,
  normalizeRepoName,
  REPO_TOKEN_RE,
  sameRepo,
} from '../src/agent/repo-name';

describe('normalizeRepoName', () => {
  it('大小写 + 首尾空白 + 内部空白都归一', () => {
    expect(normalizeRepoName(' Owner/Repo ')).toBe('owner/repo');
    expect(normalizeRepoName('Owner / Repo')).toBe('owner/repo');
    expect(normalizeRepoName('FACEBOOK/React')).toBe('facebook/react');
  });

  it('本已规范的值保持不变', () => {
    expect(normalizeRepoName('owner/repo')).toBe('owner/repo');
  });

  it('空串 / 只有空白 → 空串（调用方据此跳过）', () => {
    expect(normalizeRepoName('')).toBe('');
    expect(normalizeRepoName('   ')).toBe('');
  });
});

describe('sameRepo', () => {
  it('大小写与空白不同视为同一个仓库', () => {
    expect(sameRepo('Owner/Repo', 'owner/repo')).toBe(true);
    expect(sameRepo(' a/b ', 'A/B')).toBe(true);
  });

  it('不同仓库 / 空值 → false', () => {
    expect(sameRepo('a/b', 'a/c')).toBe(false);
    expect(sameRepo('', '')).toBe(false);
  });
});

describe('isRepoToken', () => {
  it('owner/repo 形态为真（含点、下划线、连字符）', () => {
    expect(isRepoToken('facebook/react')).toBe(true);
    expect(isRepoToken('owner/repo.js')).toBe(true);
    expect(isRepoToken('my_org/my-repo')).toBe(true);
  });

  it('日期（含两个斜杠）不是仓库名', () => {
    expect(isRepoToken('2026/10/27')).toBe(false);
    expect(REPO_TOKEN_RE.test('2026/10/27')).toBe(false);
  });

  it('纯数字两侧 / 缺一边 / 空串为假', () => {
    expect(isRepoToken('123/456')).toBe(false);
    expect(isRepoToken('no-slash')).toBe(false);
    expect(isRepoToken('a/')).toBe(false);
    expect(isRepoToken('/b')).toBe(false);
    expect(isRepoToken('')).toBe(false);
  });
});
