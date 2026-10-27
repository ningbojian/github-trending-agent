/**
 * 仓库名归一化（owner/repo）。
 *
 * GitHub 的仓库名**大小写不敏感**，但数据库里存的是抓取时拿到的原样写法：
 * trending 页、GitHub API、用户输入三条来源的大小写并不保证一致。
 * 所以判断「是不是同一个仓库」时一律走这里，不要在调用点散写 `.toLowerCase()`——
 * 散写迟早会漏一处，而漏掉的那一处正好会让「已收藏」的仓库继续出现在简报里。
 */

/** 去掉所有空白并小写：`Owner / Repo ` → `owner/repo`（仓库名本身不允许含空格）。 */
export function normalizeRepoName(fullName: string): string {
  return fullName.replace(/\s+/g, '').toLowerCase();
}

/** 两个名字是否指向同一个仓库；任一为空 → false。 */
export function sameRepo(a: string, b: string): boolean {
  const left = normalizeRepoName(a);
  const right = normalizeRepoName(b);
  return left !== '' && left === right;
}

/** 单个 token 是否为 `owner/repo` 形态（锚定整串，只允许一个斜杠）。 */
export const REPO_TOKEN_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * `owner/repo` 形态且**含字母**。
 * 含字母这一步是为了排除 `123/456` 这类纯数字 token；日期 `2026/10/27`
 * 本来就因两个斜杠无法通过 REPO_TOKEN_RE。
 */
export function isRepoToken(token: string): boolean {
  return REPO_TOKEN_RE.test(token) && /[A-Za-z]/.test(token);
}
