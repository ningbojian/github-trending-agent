import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvalFormatError,
  loadGolden,
  loadGoldenFile,
  readFixture,
} from '../evals/load';
import { GoldenCaseSchema, findForbiddenKeys } from '../evals/schema';

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-schema-'));
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

const VALID = {
  id: 'route-help',
  text: '帮助',
  expected: { route: { kind: 'handler', name: 'help' } },
};

describe('eval schema — 金标契约', () => {
  it('接受只写一层期望的用例', () => {
    const parsed = GoldenCaseSchema.parse(VALID);
    expect(parsed.expected.route?.name).toBe('help');
  });

  it('拒绝 expected 为空的用例', () => {
    const result = GoldenCaseSchema.safeParse({ id: 'x', text: 'y', expected: {} });
    expect(result.success).toBe(false);
  });

  it('拒绝非法 id（报告里要能稳定引用）', () => {
    const result = GoldenCaseSchema.safeParse({ ...VALID, id: 'Route Help' });
    expect(result.success).toBe(false);
  });

  it('递归找出用户标识字段', () => {
    const found = findForbiddenKeys({
      id: 'x',
      meta: { list: [{ wecomUserid: 'abc' }] },
    });
    expect(found).toEqual(['$.meta.list[0].wecomUserid']);
  });

  it('正常用例没有违禁字段', () => {
    expect(findForbiddenKeys(VALID)).toEqual([]);
  });
});

describe('eval loader — 逐行解析与诊断', () => {
  it('跳过空行，返回带 source 的用例', () => {
    const file = tempFile(
      'golden.jsonl',
      `${JSON.stringify(VALID)}\n\n${JSON.stringify({ ...VALID, id: 'route-help-2' })}\n`,
    );
    const cases = loadGoldenFile(file);
    expect(cases.map((c) => c.id)).toEqual(['route-help', 'route-help-2']);
    expect(cases[0]?.source).toBe(file);
  });

  it('JSON 语法错误报出 file:line', () => {
    const file = tempFile('golden.jsonl', `${JSON.stringify(VALID)}\n{not json}\n`);
    expect(() => loadGoldenFile(file)).toThrow(EvalFormatError);
    try {
      loadGoldenFile(file);
    } catch (err) {
      expect((err as Error).message).toContain(`${file}:2`);
    }
  });

  it('schema 错误也带行号', () => {
    const file = tempFile('golden.jsonl', `${JSON.stringify({ ...VALID, text: '' })}\n`);
    expect(() => loadGoldenFile(file)).toThrow(/golden\.jsonl:1:/);
  });

  it('拒绝用户标识字段（金标集匿名）', () => {
    const file = tempFile(
      'golden.jsonl',
      `${JSON.stringify({ ...VALID, wecomUserid: 'u1' })}\n`,
    );
    expect(() => loadGoldenFile(file)).toThrow(/不得包含用户标识字段/);
  });

  it('同一文件内 id 重复报错', () => {
    const file = tempFile(
      'golden.jsonl',
      `${JSON.stringify(VALID)}\n${JSON.stringify(VALID)}\n`,
    );
    expect(() => loadGoldenFile(file)).toThrow(/id 重复/);
  });

  it('跨文件 id 重复同样报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-golden-'));
    writeFileSync(join(dir, 'a.jsonl'), `${JSON.stringify(VALID)}\n`, 'utf8');
    writeFileSync(join(dir, 'b.jsonl'), `${JSON.stringify(VALID)}\n`, 'utf8');
    expect(() => loadGolden(dir)).toThrow(/id 重复/);
  });

  it('空目录直接报错，不静默通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-empty-'));
    expect(() => loadGolden(dir)).toThrow(/没有找到/);
  });
});

describe('eval loader — fixture 路径边界', () => {
  it('读取仓库内 fixture', () => {
    const fixture = readFixture('evals/fixtures/search/python-ai.json');
    expect(Array.isArray(fixture)).toBe(true);
  });

  it('拒绝绝对路径', () => {
    expect(() => readFixture('C:/windows/win.ini')).toThrow(/必须是相对路径/);
  });

  it('拒绝 ../ 逃逸', () => {
    expect(() => readFixture('../../package.json')).toThrow(/不得指向仓库外/);
  });
});
