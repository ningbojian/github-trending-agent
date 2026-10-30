/**
 * 仓库引用的解析：`owner/repo` 或 GitHub 链接 → `{ owner, name }`。
 *
 * 单独成文件是因为「工具路由」要用它做纯规则前置判断——那个模块不该为了
 * 一个正则去加载 DB / fetch 客户端。`github/client.ts` 继续 re-export，
 * 既有 import 不受影响。
 */

export interface RepoRef {
  owner: string;
  name: string;
}

/** 解析 `owner/repo` 或 GitHub 链接；非法返回 null（绝不猜）。 */
export function parseRepoRef(text: string): RepoRef | null {
  const trimmed = text.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  let candidate = trimmed;
  const urlMatch = candidate.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (urlMatch !== null) {
    const host = urlMatch[1];
    if (
      host !== undefined &&
      host.toLowerCase() !== 'github.com' &&
      host.toLowerCase() !== 'www.github.com'
    ) {
      return null;
    }
    candidate = urlMatch[2] ?? '';
  }

  const parts = candidate.split('/').filter((part) => part !== '');
  if (parts.length < 2) return null;
  const owner = parts[0] ?? '';
  const rawName = parts[1] ?? '';
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  // `.` / `..` 能通过字符集校验，却会让下游拼出的 GitHub API 路径发生穿越
  // （`/user/starred/../..`），必须在入口拒绝。
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return null;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return null;
  }
  return { owner, name };
}
