# GitHub 机会发现 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有企微/邮件/面板产品上增加「下一步机会」：每天从 GitHub 找出 2 条可填的坑 + 1 条值得研究的问题，支持「机会」命令、面板视图和周一推送。

**Architecture:** GitHub Actions 用 `GITHUB_TOKEN` 采集公开的 issue/仓库事实写入 `source_items`；Vercel 复用现有 `/api/cron-push-digest` 的 `task=opportunity` 分支，用运营方 LLM 每天生成一次共享池，写入 `kv_cache` 一行；命令/面板/周报按用户信号在内存里排序，不按用户调模型。共享池只含公开事实，用户数据不进入池或 LLM。

**Tech Stack:** TypeScript、Vercel Functions、Neon Postgres + Drizzle、Vercel AI SDK（现有 `src/agent/llm` 模式）、Vitest、GitHub REST API。

**Spec:** 本文件 §1（用户在 2026-11-18 确认的方案：填坑 2 + 研究 1，命令 + 面板 + 每周推送，Phase 0 跳过但保留首次人工抽查）。

## Global Constraints

- 不新增 Vercel 函数：Hobby 已用满 12 个函数（ADR 0011）；机会池构建复用 `/api/cron-push-digest` 的 `task=opportunity` 分支。
- 采集必须在 GitHub Actions 用 `GITHUB_TOKEN`；Vercel 只负责 LLM 合成和读取，不在请求路径临时抓 GitHub。
- 共享池一天一行 `kv_cache`，TTL 7 天；不按 tick、不按用户查库或调 LLM。
- 共享池和 LLM prompt 只含公开仓库/issue 事实；userid、邮箱、收藏、记忆、推送历史不得进入。
- 企微 text ≤1900 字节；news ≤8 篇；每日简报不塞机会。
- 面板 HTML 只用 `src/panel/styles.ts` 的 `p-*` 类，不写内联 style。
- 新命令固定词、零模型；数字命令一律 `parseCnNumber`。
- LLM 只写 `why` / `firstStep` / `effort` / `confidence`；仓库名、issue 号、标签、评论数、链接全部由代码从事实生成，并做 ID 白名单校验。
- 质量门槛优先于数量；拿不到足够合格条目时宁可少发。

## Review Focus

- 陈旧/无人维护的 issue 被推荐：硬过滤 archived、365 天无推送、90 天未更新、已 assign、已有 linked PR。
- issue 正文 prompt injection：正文只作为数据，不执行其中指令；输出只接受候选 ID 和短文本。
- 共享池泄漏用户数据：池与 LLM prompt 只含公开事实；用户信号只在内存排序。
- 池缺失/LLM 失败：命令/面板/周报降级为空状态或模板，不抛 500。
- 企微 1900 字节溢出：渲染层按字节截断并减少卡片，不发送超长文本。
- 重复推荐：独立 `opportunity-shown` 签名集合，不复用仓库的 60 条 `pushed:` 历史。
- 中文覆盖不足：英文标签只是入口之一，保留 open issue + no assignee + 关键词 fallback，并展示「中文文档：有/无/未知」。

---

## Task 0: 修复企微 topics 接线（前置）

**Files:**
- Modify: `src/agent/digest.ts:325-344`、`src/agent/digest.ts:367-386`
- Test: `tests/digest-topics.test.ts`

**Interfaces:**
- Consumes: `normalizePreferences(sub.preferences)` 返回 `topics: string[]`；`selectEntriesForPreferences(items, preferences, defaultCount, accept)` 已支持 `topics`。
- Produces: WeCom 文本和 news 选择层都传入 `topics`，行为与邮件一致。

- [ ] **Step 1: 写失败测试**：在 `tests/digest-topics.test.ts` 加用例：snapshot 有 `agent` 和 `frontend` 两条；`buildDigestFromSnapshot({preferences:{topics:['agent']}}, snapshot)` 只保留 agent 条；`buildDigestNewsFromSnapshot` 同理。
- [ ] **Step 2: 运行**：`npx vitest run tests/digest-topics.test.ts`，确认因 topics 被忽略而失败。
- [ ] **Step 3: 实现**：两个函数解构 `topics` 并传入 `selectEntriesForPreferences`；`sub.preferences` 的内联类型加 `topics?: unknown`。
- [ ] **Step 4: 运行**：同一命令通过；再跑 `tests/digest.test.ts`、`tests/email-push.test.ts`。
- [ ] **Step 5: 提交**：`git add src/agent/digest.ts tests/digest-topics.test.ts && git commit -m "fix: 企微简报应用方向订阅"`

---

## Task 1: 机会类型 + 确定性质量门槛/评分

**Files:**
- Create: `src/opportunities/types.ts`
- Create: `src/opportunities/score.ts`
- Test: `tests/opportunities-score.test.ts`

**Interfaces:**
```ts
export type OpportunityKind = 'contribute' | 'research';
export type OpportunityEffort = '小' | '中' | '大';
export type OpportunityConfidence = '高' | '中' | '低';

export interface OpportunityEvidence { label: string; value: string }

export interface RawOpportunityFact {
  id: string;                 // `${kind}:${repo}#${issueNumber}`
  kind: OpportunityKind;
  repo: string;               // owner/repo
  issueNumber: number;
  title: string;
  body: string;               // 截断后的 issue 正文
  url: string;
  language: string | null;
  topics: string[];
  stars: number;
  license: string | null;
  archived: boolean;
  pushedAt: string | null;
  labels: string[];
  comments: number;
  reactions: number;
  createdAt: string | null;
  updatedAt: string | null;
  maintainerEngaged: boolean;
  assigned: boolean;
  linkedPr: boolean;
}

export interface OpportunityItem extends RawOpportunityFact {
  score: number;
  why: string;
  firstStep: string;
  effort: OpportunityEffort;
  confidence: OpportunityConfidence;
  evidence: OpportunityEvidence[];
}

export function passesOpportunityGate(fact: RawOpportunityFact, now: number): { ok: boolean; reasons: string[] };
export function scoreOpportunity(fact: RawOpportunityFact, now: number): number;
export function toOpportunityItem(fact: RawOpportunityFact, now: number): OpportunityItem;
```
- `passesOpportunityGate` 硬拒绝：archived；pushedAt 超过 365 天；updatedAt 超过 90 天；`contribute` 且（有 assignee 或 linked PR）——这两个字段在 `RawOpportunityFact` 用 `assigned: boolean` / `linkedPr: boolean` 表示，补进类型；research 不要求未 assign。
- `scoreOpportunity`：基础 50；`good first issue` +15；`help wanted` +10；comments 1–10 +10；reactions ≥5 +10；maintainerEngaged +15；stars ≥1000 +5；research 标签 +10；越界扣分。
- `toOpportunityItem`：`why`/`firstStep` 先用确定性模板（Task 5 再覆盖），`evidence` 由代码生成（标签、评论数、维护者互动、更新时间）。

- [ ] **Step 1: 写失败测试**：`tests/opportunities-score.test.ts` 覆盖 5 个 gate 用例（正常/archived/陈旧/已 assign/有 linked PR）和 3 个评分用例（GFI 高于普通 issue、maintainerEngaged 加分、research 标签加分）。
- [ ] **Step 2: 运行**：`npx vitest run tests/opportunities-score.test.ts`，确认模块不存在而失败。
- [ ] **Step 3: 实现** `types.ts` + `score.ts`（纯函数，`now` 显式传入）。
- [ ] **Step 4: 运行**：同一命令通过。
- [ ] **Step 5: 提交**：`git add src/opportunities tests/opportunities-score.test.ts && git commit -m "feat: 机会类型与质量门槛"`

---

## Task 2: GitHub issue 列表能力

**Files:**
- Modify: `src/github/client.ts`（接口 + 实现）
- Test: `tests/github-client.test.ts`

**Interfaces:**
```ts
export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  labels: string[];
  comments: number;
  reactions: number;
  createdAt: string | null;
  updatedAt: string | null;
  authorAssociation: string | null;
  pullRequest: boolean;
}
export interface GithubClient {
  // 现有 4 个方法不变
  listIssues(
    ref: RepoRef,
    options: { labels?: string[]; state?: 'open'; perPage?: number; token: string | null },
  ): Promise<GithubResult<IssueInfo[]>>;
}
```
- 使用现有 `request` 的 6s 超时/3 次重试；`GET /repos/{owner}/{repo}/issues?state=open&per_page=...&labels=...`；过滤 `pull_request` 字段；`reactions` 取 `reactions.total_count`（缺失按 0）。
- 注意 `labels` 参数是 AND：调用方要按单个标签分别请求，不要传多个。

- [ ] **Step 1: 写失败测试**：`tests/github-client.test.ts` 模拟 fetch 返回两条 issue（一条带 `pull_request`），断言 `listIssues` 过滤 PR、解析 labels/url/comments/reactions。
- [ ] **Step 2: 运行**：`npx vitest run tests/github-client.test.ts`，确认 `listIssues` 不存在。
- [ ] **Step 3: 实现**接口与实现；所有现有 mock 的 `GithubClient` 对象补 `listIssues`（用 `grep -rn "GithubClient"` 找）。
- [ ] **Step 4: 运行**：`npx vitest run tests/github-client.test.ts tests/repo-health.test.ts tests/tools.test.ts`。
- [ ] **Step 5: 提交**：`git add src/github/client.ts tests && git commit -m "feat: GitHub issue 列表"`

---

## Task 3: 采集脚本写入 source_items

**Files:**
- Create: `src/opportunities/collect.ts`
- Create: `src/opportunities/run-collect.ts`
- Test: `tests/opportunities-collect.test.ts`

**Interfaces:**
```ts
export interface CollectResult {
  facts: RawOpportunityFact[];
  reposChecked: number;
  requests: number;
  errors: string[];
}
export async function collectOpportunities(
  now: Date,
  deps?: { client?: GithubClient; listCandidateRepos?: (now: Date) => Promise<string[]> },
): Promise<CollectResult>;
export async function upsertOpportunityFacts(facts: RawOpportunityFact[], date: string): Promise<number>;
```
- 候选仓库：当日 `trending_entries` 前 20 + `source_items` 中 `source='github-search'` 最近 7 天前 30 个；去重，硬上限 60。
- 每个仓库：`getRepo` + `listIssues`（`good first issue` 与 `help wanted` 各一次，perPage 10）+ 对前 20 个仓库加一次 `RFC` 查询；过滤 PR。
- 维护者互动：对首轮评分前 20 的 issue 拉一次 comments（`GET /repos/{o}/{r}/issues/{n}/comments?per_page=20`），看 `author_association` 是否 `OWNER|MEMBER|COLLABORATOR`；单个失败不影响整批。
- `source_items` upsert：`source='opportunity'`、`itemType='issue'`、`sourceId='owner/repo#number'`、`title/url/description=body 截断 2000/topics/metrics/raw/capturedDate`。沿用 `src/sources/run-sources.ts` 的 `onConflictDoUpdate` 模式。
- `run-collect.ts`：连 DB，打印 `facts/reposChecked/requests/errors`；全失败才 exit 1。

- [ ] **Step 1: 写失败测试**：fake client 返回两条 issue + 一条 PR，断言只写入两条、PR 被过滤、`source_items` upsert 参数正确、单个 repo 抛错不影响其他 repo。
- [ ] **Step 2: 运行**：`npx vitest run tests/opportunities-collect.test.ts`，确认失败。
- [ ] **Step 3: 实现** `collect.ts` + `run-collect.ts`；DB 用 `db()`，测试 mock `../src/db/client`。
- [ ] **Step 4: 运行**：同一命令通过。
- [ ] **Step 5: 提交**：`git add src/opportunities tests/opportunities-collect.test.ts && git commit -m "feat: 机会事实采集"`

---

## Task 4: 共享池缓存 + 构建端点

**Files:**
- Create: `src/opportunities/pool.ts`
- Modify: `api/cron-push-digest.ts`（`CronRequest.query` + `task=opportunity` 分支）
- Test: `tests/opportunities-pool.test.ts`、`tests/cron-weekly.test.ts`

**Interfaces:**
```ts
export const OPPORTUNITY_POOL_PREFIX = 'opportunity-pool:v1:';
export interface OpportunityPool {
  version: 1;
  date: string;        // 北京日期
  dataDate: string;    // source_items.capturedDate
  generatedAt: string; // ISO
  items: OpportunityItem[];
}
export async function readOpportunityPool(now: Date): Promise<OpportunityPool | null>;
export async function buildOpportunityPool(now: Date): Promise<{ pool: OpportunityPool | null; reason?: string }>;
export function poolKey(date: string): string;
```
- `readOpportunityPool`：`kv_cache` 取 `opportunity-pool:v1:<北京日期>`，校验 version/date/items/dataDate；过期或形状不对返回 null。
- `buildOpportunityPool`：用 `kv_cache` 的 `opportunity-build:v1:<date>` 做 `onConflictDoNothing` 锁；读 `source_items` 当天 `source='opportunity'`；`passesOpportunityGate` + `scoreOpportunity`；选 contribute 前 12 + research 前 6；调 `summarizeOpportunities`（Task 5）；写池（TTL 7 天）；`finally` 删锁。没有原始数据返回 `{pool:null, reason:'no-data'}`。
- 端点：`CronRequest` 加 `query?: Record<string, string | string[] | undefined>`；鉴权后若 `task==='opportunity'`，调用 `buildOpportunityPool` 并返回 `{ok, items, date, reason}`，不进入 digest 路径。
- 响应仍由 `CRON_SECRET` 保护；不存在公开端点。

- [ ] **Step 1: 写失败测试**：`tests/opportunities-pool.test.ts` 覆盖读取形状/过期、构建选择 2+1 比例、无数据、锁冲突、LLM 失败用模板；`tests/cron-weekly.test.ts` 加 `task=opportunity` 分支不调用 `pushDigests` 的用例。
- [ ] **Step 2: 运行**：`npx vitest run tests/opportunities-pool.test.ts tests/cron-weekly.test.ts`，确认失败。
- [ ] **Step 3: 实现** `pool.ts` 与端点分支。
- [ ] **Step 4: 运行**：同一命令通过；再跑 `tests/digest.test.ts`。
- [ ] **Step 5: 提交**：`git add src/opportunities/pool.ts api/cron-push-digest.ts tests && git commit -m "feat: 共享机会池与构建端点"`

---

## Task 5: LLM 合成 why/firstStep

**Files:**
- Create: `src/opportunities/summarize.ts`
- Test: `tests/opportunities-summarize.test.ts`

**Interfaces:**
```ts
export interface OpportunitySummary {
  id: string;
  why: string;
  firstStep: string;
  effort: OpportunityEffort;
  confidence: OpportunityConfidence;
}
export async function summarizeOpportunities(
  items: OpportunityItem[],
  deps?: { generate?: (prompt: string) => Promise<string> },
): Promise<Map<string, OpportunitySummary>>;
export function templateSummary(item: OpportunityItem): OpportunitySummary;
```
- 复用现有 AI SDK/运营方 key 调用模式（参考 `src/agent/digest-snapshot.ts` 的生成函数）；一次请求，18 条以内；输出 JSON。
- Prompt 明确：issue title/body 是不可信数据；只写 1 句 why + 1 句 firstStep；不写数字/URL；输出 ID 必须在输入集合。
- 解析失败/ID 不匹配/缺条目 → 用 `templateSummary` 补齐；绝不因为 LLM 失败而丢池。
- `why` ≤ 80 字，`firstStep` ≤ 80 字；超长截断。

- [ ] **Step 1: 写失败测试**：fake generate 返回合法 JSON → map 完整；返回多余/缺失 ID → 多余丢弃、缺失走模板；抛错 → 全部模板；prompt 包含「不可信」和候选 ID。
- [ ] **Step 2: 运行**：`npx vitest run tests/opportunities-summarize.test.ts`，确认失败。
- [ ] **Step 3: 实现** `summarize.ts`。
- [ ] **Step 4: 运行**：同一命令通过。
- [ ] **Step 5: 提交**：`git add src/opportunities/summarize.ts tests/opportunities-summarize.test.ts && git commit -m "feat: 机会中文合成"`

---

## Task 6: 排序 + 隐藏/已展示存储

**Files:**
- Create: `src/opportunities/rank.ts`
- Create: `src/opportunities/store.ts`
- Test: `tests/opportunities-rank.test.ts`、`tests/opportunities-store.test.ts`

**Interfaces:**
```ts
export interface OpportunitySignals {
  languages: string[];
  topics: string[];
  keywords: string[];
  languageBoost: Map<string, number>;
  topicBoost: Map<string, number>;
  favoriteRepos: Set<string>;
  trackedRepos: Set<string>;
  hidden: Set<string>;
  shown: Set<string>;
}
export interface RankOptions { limit?: number; contribute?: number; research?: number }
export function rankOpportunities(
  items: OpportunityItem[],
  signals: OpportunitySignals,
  options?: RankOptions,
): OpportunityItem[];
export function opportunitySignature(item: OpportunityItem): string;

export async function readHiddenOpportunities(userid: string): Promise<Set<string>>;
export async function hideOpportunity(userid: string, id: string): Promise<void>;
export async function readShownOpportunities(userid: string): Promise<Set<string>>;
export async function markOpportunitiesShown(userid: string, ids: string[]): Promise<void>;
```
- 排序分：`2.5*语言 boost + 1.5*topic boost + 1.0*方向 + 0.8*关键词 + 0.5*收藏/追踪熟悉度 + 1.5*类型项`；类型项：contribute = (100-score)/100 + 可行动性，research = 讨论量/维护者互动。
- 硬过滤：订阅了语言但条目语言不在其中；`hidden` / `shown`；同一 repo 最多 1 条；同一语言最多 2 条。
- 默认 `limit=3`、`contribute=2`、`research=1`；不足时从另一类补，仍不足就少发。
- `store.ts` 用 `kv_cache`：`opportunity-hidden:<userid>`、`opportunity-shown:<userid>`，value `{ids: string[], updatedAt}`，TTL 30/14 天；读失败返回空集合（fail-open）。

- [ ] **Step 1: 写失败测试**：语言/方向/关键词命中排序、hidden 过滤、同 repo 去重、2+1 选择、不足时降级、store 读写与 TTL。
- [ ] **Step 2: 运行**：`npx vitest run tests/opportunities-rank.test.ts tests/opportunities-store.test.ts`，确认失败。
- [ ] **Step 3: 实现** `rank.ts` + `store.ts`。
- [ ] **Step 4: 运行**：同一命令通过。
- [ ] **Step 5: 提交**：`git add src/opportunities tests/opportunities-rank.test.ts tests/opportunities-store.test.ts && git commit -m "feat: 机会排序与去重"`

---

## Task 7: 企微「机会」命令

**Files:**
- Create: `src/wecom/opportunity.ts`
- Modify: `src/wecom/route-decision.ts`（HandlerKey + 匹配）
- Modify: `src/wecom/router.ts`（Handlers 接口 + 注册）
- Modify: `src/wecom/onboarding.ts`（帮助文案）
- Modify: `evals/golden/routing.jsonl`
- Test: `tests/opportunity-command.test.ts`、`tests/router.test.ts`、`evals` 跑通

**Interfaces:**
```ts
export async function handleOpportunities(msg: InboundMessage): Promise<void>;
export function formatOpportunityReply(items: OpportunityItem[]): string;
```
- 命令固定词：`机会`、`下一步`、`我能做什么`、`有什么可以做的`；精确匹配，不吞搜索。
- Handler：读 `readOpportunityPool(new Date())`；空 → 回「今天的机会池还没准备好，晚点再试」；读订阅/口味/star/收藏/追踪 + `readHiddenOpportunities`；`rankOpportunities`；`formatOpportunityReply`；发送失败只 log。
- 渲染：每条 4 行，含 `[填坑]/[研究]`、repo#issue、标题、为什么、第一步、难度/置信度、GitHub 链接；总字节 ≤1900，超长从尾部减卡片。
- 帮助文案加一行；`evals/golden/routing.jsonl` 加 3 条，`npm run eval:ci` 必须通过。

- [ ] **Step 1: 写失败测试**：路由 4 个命令、面板 token 不被误判、池空回复、2+1 渲染、超长截断、发送失败不抛。
- [ ] **Step 2: 运行**：`npx vitest run tests/opportunity-command.test.ts tests/router.test.ts`，确认失败。
- [ ] **Step 3: 实现** handler、路由、帮助、金标。
- [ ] **Step 4: 运行**：同上 + `npm run eval:ci`。
- [ ] **Step 5: 提交**：`git add src/wecom api tests evals && git commit -m "feat: 企微机会命令"`

---

## Task 8: 面板「机会」视图 + 操作

**Files:**
- Create: `src/panel/opportunity-view.ts`
- Modify: `api/panel.ts`（NAV_ITEMS、view 分支、POST actions）
- Modify: `src/panel/styles.ts`（仅必要时加类）
- Test: `tests/panel-opportunity.test.ts`、`tests/ui-styles.test.ts`

**Interfaces:**
```ts
export async function renderOpportunityView(ctx: {
  token: string;
  userid: string;
  now: Date;
}): Promise<string>;
```
- `NAV_ITEMS` 加 `{view:'opportunities', label:'机会'}`；view 分支调用 `renderOpportunityView`。
- 视图：3–6 张卡（contribute/research），每张显示 kind、repo#issue、标题、why、firstStep、evidence chips、难度/置信度、GitHub 链接，以及「追踪仓库 / 不感兴趣」按钮；空状态文案。
- POST actions：`opp-hide`（`hideOpportunity`）、`opp-track`（现有 `trackRepo`）、`opp-favorite`（现有 `favoriteRepo`）；成功后 `bumpPanelDirty` 并 303 回 `view=opportunities`。
- 面板缓存 30 秒自动含 view key；不要改缓存逻辑。
- 样式只用 `p-card`、`p-chip`、`p-btn`、`p-empty`；移动端沿用现有布局。

- [ ] **Step 1: 写失败测试**：视图渲染 3 条、空状态、HTML 转义、opp-hide 写隐藏集合、opp-track 调服务层、未知 action 不崩。
- [ ] **Step 2: 运行**：`npx vitest run tests/panel-opportunity.test.ts`，确认失败。
- [ ] **Step 3: 实现** view + actions + 样式（如需要）。
- [ ] **Step 4: 运行**：同上 + `tests/panel.test.ts` + `tests/ui-styles.test.ts`。
- [ ] **Step 5: 提交**：`git add src/panel api/panel.ts tests && git commit -m "feat: 面板机会视图"`

---

## Task 9: 周一企微机会推送

**Files:**
- Create: `src/agent/weekly-opportunities.ts`
- Modify: `api/cron-push-digest.ts`（weekly gate 调用 + 响应字段）
- Modify: `src/agent/preferences.ts`（`weeklyOpportunities` 默认 true）
- Modify: `api/panel.ts`（设置页开关）
- Test: `tests/weekly-opportunities.test.ts`、`tests/preferences.test.ts`

**Interfaces:**
```ts
export async function pushWeeklyOpportunities(
  now: Date,
  options?: { send?: (userid: string, text: string) => Promise<void> },
): Promise<{ sent: number; skipped: number; failed: number }>;
```
- 读 active 企微订阅者；`weeklyOpportunities === false` 跳过；池空全部跳过。
- 每人 claim `kv_cache` `opportunity-weekly:<userid>:<date>`（`onConflictDoNothing`），已 claim 跳过；每个用户 2 contribute + 1 research；无合格条目跳过；发送前 `markOpportunitiesShown`。
- 每轮 ≤50 人、逐人 try/catch；返回计数；cron 响应加 `opportunities` 字段（heartbeat 同步加）。
- 面板设置加「每周一机会推送」开关，写 `weeklyOpportunities`。

- [ ] **Step 1: 写失败测试**：默认开、关掉不发、池空跳过、claim 只发一次、2+1、发送失败计数、cron 周 gate 调用。
- [ ] **Step 2: 运行**：`npx vitest run tests/weekly-opportunities.test.ts tests/preferences.test.ts`，确认失败。
- [ ] **Step 3: 实现** sender + preference + cron hook + 面板开关。
- [ ] **Step 4: 运行**：同上 + `tests/cron-weekly.test.ts` + `tests/panel.test.ts`。
- [ ] **Step 5: 提交**：`git add src api tests && git commit -m "feat: 周一机会推送"`

---

## Task 10: 邮件周一「本周机会」区块

**Files:**
- Modify: `src/email/preferences.ts`（`weeklyOpportunities` 默认 true + 设置表单解析）
- Modify: `src/email/push.ts`（周一读池、按用户排序）
- Modify: `src/email/render.ts`（可选 opportunity section）
- Modify: `api/email-settings.ts`（复选框）
- Test: `tests/email-preferences.test.ts`、`tests/email-endpoints.test.ts`、`tests/email-render.test.ts`

**Interfaces:**
- `EmailPreferences` 加 `weeklyOpportunities: boolean`；`normalizeEmailPreferences` 默认 true；`validateEmailPreferencesInput` 解析复选框。
- `renderDigestEmail` options 加 `opportunities?: OpportunityItem[]`；在 items 后追加「本周机会」区块，链接到 GitHub，HTML 转义。
- `pushEmailDigests` 在周一（北京日期）且用户未关闭时，读一次共享池、按邮件偏好排序 2+1、传入 render；池缺失/失败静默省略。
- 设置页加复选框；保存后生效。

- [ ] **Step 1: 写失败测试**：默认 true / 显式 false、周一渲染 3 条、周二不渲染、池空省略、设置页复选框保存。
- [ ] **Step 2: 运行**：`npx vitest run tests/email-preferences.test.ts tests/email-render.test.ts tests/email-endpoints.test.ts`，确认失败。
- [ ] **Step 3: 实现** 偏好、渲染、推送、设置页。
- [ ] **Step 4: 运行**：同上通过。
- [ ] **Step 5: 提交**：`git add src/email api/email-settings.ts tests && git commit -m "feat: 邮件周一机会区块"`

---

## Task 11: GitHub Actions 采集 + 构建步骤

**Files:**
- Modify: `.github/workflows/daily.yml`
- Test: 手工验证（YAML 无测试）

- [ ] **Step 1:** 在「抓取多源榜单」后加 `采集机会事实`：`npx tsx src/opportunities/run-collect.ts`，`continue-on-error: true`，失败打 warning。
- [ ] **Step 2:** 加 `构建机会池`：`curl -sS --max-time 150 -X POST "https://${VERCEL_URL}/api/cron-push-digest?task=opportunity" -H "Authorization: Bearer ${CRON_SECRET}"`，`if: env.VERCEL_URL != '' && env.CRON_SECRET != ''`，`continue-on-error: true`；非 200 打 warning，不让管线红。
- [ ] **Step 3:** 保留现有「兜底触发一次简报推送」在后；确认 `daily.yml` 仍在 20 分钟预算内。
- [ ] **Step 4:** 本地用 `act` 不可用时，至少 `python -c "import yaml"` 或 GitHub 手动 `workflow_dispatch` 验证。
- [ ] **Step 5: 提交**：`git add .github/workflows/daily.yml && git commit -m "ci: 每日采集并构建机会池"`

---

## Task 12: 全量验证 + 首次人工抽查 + 部署

- [ ] **Step 1:** `npm test` 全绿；`npx tsc --noEmit` 干净；`npm run eval:ci` 通过。
- [ ] **Step 2:** 手动跑一次 `run-collect.ts`（本地 `.env` 需要 `NEON_DATABASE_URL` + `GITHUB_TOKEN`），检查写入条数。
- [ ] **Step 3:** 手动调 `task=opportunity`（本地/预览），生成当天池；人工抽查 20 条：是否陈旧、是否已 assign、是否有明确第一步、中文覆盖如何；不达标就调门槛后重跑。
- [ ] **Step 4:** 分支 review（superpowers:requesting-code-review），修复 Important。
- [ ] **Step 5:** 合并 main、推送、确认 Vercel 部署；部署后看一次 `opportunity-pool:v1:<date>` 和命令/面板。
- [ ] **Step 6:** 监控：池大小、采集成功数、LLM token、命令/面板使用、周报发送计数；前 3 天每天人工看一次。
