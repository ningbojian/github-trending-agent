import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoldenCaseSchema, findForbiddenKeys, type GoldenCase } from './schema.js';

/** 仓库根目录（evals/ 的上一级）。 */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 评测文件格式错误：带 file:line，修数据时不用猜是哪条。 */
export class EvalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFormatError';
  }
}

export interface LoadedCase extends GoldenCase {
  /** 来源文件（诊断用，不参与评分）。 */
  source: string;
}

/**
 * 加载一个 JSONL 文件。空行跳过；每行必须是完整 JSON 对象，
 * 且不得包含任何用户标识字段（匿名是金标集的硬约束）。
 */
export function loadGoldenFile(filePath: string): LoadedCase[] {
  const raw = readFileSync(filePath, 'utf8');
  const cases: LoadedCase[] = [];
  const seen = new Set<string>();

  raw.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const where = `${filePath}:${index + 1}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new EvalFormatError(
        `${where}: 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
      );
    }

    const forbidden = findForbiddenKeys(parsed);
    if (forbidden.length > 0) {
      throw new EvalFormatError(`${where}: 不得包含用户标识字段：${forbidden.join(', ')}`);
    }

    const result = GoldenCaseSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new EvalFormatError(`${where}: ${detail}`);
    }
    if (seen.has(result.data.id)) {
      throw new EvalFormatError(`${where}: id 重复：${result.data.id}`);
    }
    seen.add(result.data.id);
    cases.push({ ...result.data, source: filePath });
  });

  return cases;
}

/**
 * 加载 golden 目录下全部 *.jsonl（按文件名排序）。
 * ID 全局唯一——跨文件重复同样报错，否则报告里会分不清是哪条。
 */
export function loadGolden(goldenDir = join(REPO_ROOT, 'evals', 'golden')): LoadedCase[] {
  const files = readdirSync(goldenDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) {
    throw new EvalFormatError(`${goldenDir}: 没有找到任何 *.jsonl 金标文件`);
  }

  const all: LoadedCase[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const full = join(goldenDir, file);
    for (const item of loadGoldenFile(full)) {
      const previous = seen.get(item.id);
      if (previous !== undefined) {
        throw new EvalFormatError(
          `${full}: id 重复：${item.id}（已在 ${previous} 出现）`,
        );
      }
      seen.set(item.id, full);
      all.push(item);
    }
  }
  return all;
}

/**
 * 读 fixture。路径必须留在仓库内（拒绝 ../ 逃逸），
 * 解析失败直接报出文件名——fixture 是评测输入，不该静默降级。
 */
export function readFixture(relativePath: string): unknown {
  if (isAbsolute(relativePath)) {
    throw new EvalFormatError(`fixture 必须是相对路径：${relativePath}`);
  }
  const full = resolve(REPO_ROOT, relativePath);
  const rel = relative(REPO_ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new EvalFormatError(`fixture 不得指向仓库外：${relativePath}`);
  }
  const raw = readFileSync(full, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new EvalFormatError(
      `${relativePath}: 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
}
