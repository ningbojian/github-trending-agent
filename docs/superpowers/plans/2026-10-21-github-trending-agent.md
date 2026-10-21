# GitHub Trending Agent（企微版）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于企业微信自建应用的对话式 GitHub Trending Agent：每日自动抓取热榜并推送个性化简报到用户微信，支持自然语言多维检索历史热榜，聊天内收藏仓库并同步 star 到用户 GitHub 账号。

**Architecture:** 单仓库 TypeScript。GitHub Actions 每日抓取 trending 页 + GitHub API 补全 topics 后写入 Neon Postgres，再回调 Vercel 上的推送接口生成 AI 简报；企业微信回调接口（Vercel Function）接收用户消息，经 LLM 结构化解析为 SQL 过滤条件检索历史库，异步回复到同一微信会话；用户经 GitHub OAuth 绑定后，收藏命令双向同步 star。LLM 经 Vercel AI SDK 抽象，环境变量切换提供商。

**Tech Stack:** TypeScript strict / Node 20、Vercel Functions（Node runtime）、Neon Postgres + Drizzle ORM（HTTP driver）、Vercel AI SDK（ai + @ai-sdk/anthropic|openai|deepseek|ali）、zod、vitest、GitHub Actions。

**Spec:** [README.md](../../../GitHub Trending Agent/README.md)、[docs/research/2026-10-21-competitor-analysis.md](../research/2026-10-21-competitor-analysis.md)、[docs/research/2026-10-21-wechat-channel-analysis.md](../research/2026-10-21-wechat-channel-analysis.md)

**选型说明（对 README 的偏离与理由）：** README 提及 LangGraph。本计划用 Vercel AI SDK 的结构化输出 + tool calling 替代：MVP 的"解析查询条件"是单次结构化抽取（非多步图编排），AI SDK 在 Vercel 上是零配置一等公民且原生多提供商。`parse-query.ts` 保持窄接口（输入消息文本 → 输出 `SearchQuery`），后续若需多轮澄清式检索可无痛换成 LangGraph.js。

## Global Constraints

- Node ≥ 20，TypeScript `strict: true`，ESM。
- 所有密钥仅经环境变量；仓库内出现任何 secret 视为 bug。
- **企业微信回调必须 < 5s 响应**：收到 POST 后先完成验签/解密/路由分发并返回空串，LLM 调用与回复发送一律在响应之后执行。
- GitHub OAuth 仅申请 `public_repo` scope（最小权限，竞品 Diffmatic 因权限过宽流失用户的教训）。
- 所有用户可见文案为中文。
- MVP 按未认证企微（约100人）设计，但代码不得硬编码该上限；订阅表设计与通道解耦（预留认证迁移与多通道适配器）。
- 数据库访问一律用 `@neon-database/serverless` HTTP driver（适配 serverless），不用长连接 pg。

## Review Focus

以下 5 类失败模式没有任务的测试自然覆盖，各任务须包含对应回归测试：

1. **企微回调超时/丢消息** — 合理预期：LLM 慢也不丢用户消息、不超时。测试钉在 Task 5（callback 先返回、处理后置的顺序断言）。
2. **企微 AES 加解密错误** — 合理预期：与官方样例向量互通。测试钉在 Task 5（官方文档样例的 msg_signature/decrypt 向量）。
3. **trending 页改版导致空抓取** — 合理预期：解析结果为空时告警而非静默覆盖数据。测试钉在 Task 2（空结果触发失败信号）与 Task 4（Actions 失败通知到企微）。
4. **star 同步失败（token 过期/被撤销）** — 合理预期：用户收到明确的重新绑定提示，而非静默失败。测试钉在 Task 12。
5. **LLM 输出不可解析/幻觉过滤条件** — 合理预期：回退正则解析器或友好帮助消息。测试钉在 Task 7。

---

### Task 1: 项目脚手架 + 数据库 Schema

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`.env.example`、`src/config.ts`、`src/db/schema.ts`、`src/db/client.ts`、`drizzle.config.ts`
- Test: `tests/config.test.ts`、`tests/schema.test.ts`

**Interfaces:**
- Produces: `export const repos/trendingEntries/subscribers/favorites/searchCaches/kvCache`（drizzle 表定义）；`export function db(): NeonHttpDatabase`；`export const env: Env`（含 `NEON_DATABASE_URL, LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, WECOM_CORP_ID, WECOM_AGENT_ID, WECOM_SECRET, WECOM_CALLBACK_TOKEN, WECOM_CALLBACK_AES_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_OAUTH_REDIRECT_URI, CRON_SECRET, TOKEN_ENCRYPT_KEY, GITHUB_TOKEN?`，zod 校验，缺省即抛）。

Schema 要点：
- `repos(full_name PK, name, owner, description, language, topics jsonb, stars, html_url)`
- `trending_entries(id, full_name FK, date, period 'daily'|'weekly', language, rank, stars_at_capture, stars_delta, is_new, source)`，unique(date, period, language, full_name)
- `subscribers(id, wecom_userid unique, display_name, preferences jsonb {languages[], keywords[]}, github_login?, github_token_enc?, active, created_at)`
- `favorites(id, wecom_userid, full_name, starred_on_github bool, created_at)`，unique(wecom_userid, full_name)
- `search_caches(id, wecom_userid, results jsonb, created_at)` — 存最近一次检索结果供"收藏 N"引用
- `kv_cache(key PK, value jsonb, expires_at)` — 存企微 access_token

- [ ] **Step 1: 写 `tests/config.test.ts`** — 断言：缺 `NEON_DATABASE_URL` 时 `loadEnv({})` 抛出含字段名的错误；全量 env 时返回解析后的对象。
- [ ] **Step 2: 跑测试确认 FAIL** — `npx vitest run tests/config.test.ts`，期望 "loadEnv is not a function" 类失败。
- [ ] **Step 3: 实现脚手架与 `loadEnv`** — `package.json` scripts: `test, db:generate, db:migrate, dev`；依赖见 Tech Stack；`src/config.ts` 导出 `loadEnv(raw: NodeJS.ProcessEnv): Env` 与惰性单例 `env`。
- [ ] **Step 4: 跑测试确认 PASS** — `npx vitest run tests/config.test.ts`。
- [ ] **Step 5: 写 `tests/schema.test.ts`** — 断言：drizzle introspection 或直接引用表定义，检查 `trending_entries` 含唯一约束列组合、`subscribers.preferences` 为 jsonb 类型。
- [ ] **Step 6: 跑测试确认 FAIL 后实现 `src/db/schema.ts` 与 `src/db/client.ts`** — `db()` 用 `neon(process.env.NEON_DATABASE_URL)` + `drizzle()`。
- [ ] **Step 7: 跑全部测试 PASS；`npx drizzle-kit generate` 产出迁移 SQL** — 迁移文件提交。
- [ ] **Step 8: Commit** — `chore: scaffold project with drizzle schema and env validation`

### Task 2: Trending 抓取与解析（纯逻辑，供 Actions 调用）

**Files:**
- Create: `src/scraper/trending.ts`、`src/scraper/run-scraper.ts`
- Test: `tests/fixtures/trending-daily.html`（真实页面快照）、`tests/trending.test.ts`

**Interfaces:**
- Consumes: `db()`、schema。
- Produces: `export function parseTrendingHtml(html: string, period: 'daily'|'weekly'): ParsedRepo[]`（`ParsedRepo = { fullName, name, owner, description, language, stars, starsDelta, isNew, rank }`）；`export async function scrapeAndUpsert(): Promise<{ inserted: number, languages: number }>`；`run-scraper.ts` 为 CLI 入口，解析数为 0 时 `process.exit(1)`。

- [ ] **Step 1: 写 `tests/trending.test.ts`** — 用 fixture 断言：解析出 ≥ 25 条、首条 fullName/rank/starsDelta 正确、`isNew` 与 issue 标记一致；`parseTrendingHtml('')` 返回 `[]`；`parseTrendingHtml('<html>改版后的怪页面</html>')` 返回 `[]`。
- [ ] **Step 2: 跑测试确认 FAIL**。
- [ ] **Step 3: 实现 `parseTrendingHtml`** — 用正则/轻量 HTML 解析（`node-html-parser`），按 `article.Box-row` 切分；不发网络请求（纯函数）。
- [ ] **Step 4: 跑测试 PASS**。
- [ ] **Step 5: 实现 `scrapeAndUpsert` 与 `run-scraper.ts`** — 抓 `https://github.com/trending?since=daily`（全部语言）与 per-language 页（取 `config` 常量 `SCRAPER_LANGUAGES = ['python','typescript','go','rust','java']`）；upsert repos + trending_entries（当日幂等）；CLI 入口在 `inserted === 0` 时 exit 1（触发 Actions 失败告警）。
- [ ] **Step 6: 本地烟测** — `npx tsx src/scraper/run-scraper.ts`（需本地 env 指向 Neon branch），确认 Neon 中有当日数据。
- [ ] **Step 7: Commit** — `feat: trending scraper with empty-result failure signal`

### Task 3: GitHub API 补全 topics

**Files:**
- Create: `src/github/enrich.ts`
- Test: `tests/enrich.test.ts`

**Interfaces:**
- Produces: `export async function enrichMissingTopics(fullNames: string[], token: string): Promise<number>`（返回补全条数；对 repos 表中 topics 为空的仓库逐个调 `GET /repos/{owner}/{repo}`（带 `token` 头）写回 topics/description/language/stars；404 与限流需重试退避，限流耗尽时返回已补数并 warn，不抛）。

- [ ] **Step 1: 写 `tests/enrich.test.ts`** — mock `fetch`：正常补全 2 条；404 跳过；403 rate-limit 时返回已处理数且不抛异常。
- [ ] **Step 2: FAIL → 实现 → PASS** — 实现见上；限流退避用指数 backoff（上限 3 次）。
- [ ] **Step 3: Commit** — `feat: github topics enrichment with rate-limit backoff`

### Task 4: GitHub Actions 每日管线

**Files:**
- Create: `.github/workflows/daily.yml`
- Test: 无单测（YAML），以 workflow_dispatch 手动跑一次验证

**Interfaces:**
- Consumes: Task 2 CLI、Task 3 enrich（在 scraper 后追加一步 tsx 调用 enrich）、`POST {VERCEL_URL}/api/cron-push-digest`（Header: `Authorization: Bringe ${CRON_SECRET}`）。

- [ ] **Step 1: 写 workflow** — cron `0 1 * * *`（UTC，北京 9 点）+ `workflow_dispatch`；步骤：checkout → setup-node 20 → `npm ci` → run scraper CLI → run enrich CLI → `curl -X POST .../api/cron-push-digest` → `if: failure()` 步骤：curl 企微发消息 API 向管理员 `WECOM_ADMIN_USERID` 发失败告警文本（用 `WECOM_SECRET` 现取 token）。
- [ ] **Step 2: 手动 dispatch 验证全链路**（部署 Vercel 与配置 secrets 在 Task 5 前置说明中完成；此步可与 Task 5-6 后的联调合并执行）。
- [ ] **Step 3: Commit** — `ci: daily trending pipeline with failure alert`

### Task 5: 企微回调端点（验签/解密/异步分发）

**Files:**
- Create: `src/wecom/crypto.ts`、`src/wecom/api.ts`、`api/wecom-callback.ts`、`src/wecom/router.ts`
- Test: `tests/wecom-crypto.test.ts`、`tests/router.test.ts`、`tests/callback.test.ts`

**Interfaces:**
- Produces:
  - `class WxbizMsgCrypt { constructor(token, aesKey, corpId); verifyUrl(msgSignature, timestamp, nonce, echostr): string; decryptMsg(msgSignature, timestamp, nonce, encryptMsg): string; encrypt(text): { encrypt, msgSignature, nonce } }`
  - `export async function getWeComAccessToken(): Promise<string>`（kv_cache 持久化 + 内存缓存，过期前 5 分钟刷新）
  - `export async function sendWeComText(userId: string, content: string): Promise<void>`
  - `export function routeMessage(msg: InboundMessage): Promise<void>`（Task 7/10/12 挂接各 handler）
  - `api/wecom-callback.ts`：GET 处理 URL 验证；POST 解密 → `routeMessage`（`void routeMessage(...)` 不 await）→ **立即返回 200 空串**。
  - `InboundMessage = { toUserName, fromUserName, createTime, msgType, content, msgId }`

- [ ] **Step 1: 写 `tests/wecom-crypto.test.ts`** — 用企微官方文档样例（token/AESKey/corpId/明文/密文/签名样例）断言 `decryptMsg` 与 `encrypt` 双向正确；篡改签名时抛错。
- [ ] **Step 2: FAIL → 实现 `crypto.ts`（AES-256-CBC + PKCS#7 + sha1 签名）→ PASS**。
- [ ] **Step 3: 写 `tests/router.test.ts`** — `routeMessage` 按 content 分发：`帮助`→helpHandler、`收藏 1`→favoriteHandler、其他→searchHandler（用 vi.mock 断言分发目标）；未知消息类型（图片）静默忽略。
- [ ] **Step 4: FAIL → 实现 `router.ts` 骨架（handler 注册表 `registerHandlers()`）→ PASS**。
- [ ] **Step 5: 写 `tests/callback.test.ts`** — 用官方加密样例构造 POST body：断言 handler 在响应**之前**未被调用（时序）、返回体为空串、handler 在返回后被异步调用（用 vi.fn + 微任务时序断言）。
- [ ] **Step 6: FAIL → 实现 `api/wecom-callback.ts` → PASS**；同时实现 `api.ts` 的 token 缓存与 `sendWeComText`（mock fetch 测试：token 命中 kv_cache 不重复获取）。
- [ ] **Step 7: Commit** — `feat: wecom callback with aes crypto and async dispatch`

### Task 6: LLM 多提供商客户端

**Files:**
- Create: `src/agent/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Produces: `export function llm(): LanguageModel`（按 `env.LLM_PROVIDER` ∈ `anthropic|openai|deepseek|ali` 实例化对应 provider，model 取 `env.LLM_MODEL`）；`export async function generateObjectSafe<T>(schema: ZodSchema<T>, prompt: string): Promise<T | null>`（失败/校验不过返回 null，不抛）。

- [ ] **Step 1: 写 `tests/llm.test.ts`** — provider 分支实例化正确（mock 各 provider 包）；`generateObjectSafe` 在 SDK 抛错与 zod 校验失败时均返回 null。
- [ ] **Step 2: FAIL → 实现 → PASS**。
- [ ] **Step 3: Commit** — `feat: multi-provider llm client with safe structured output`

### Task 7: 自然语言查询解析（核心差异化）

**Files:**
- Create: `src/agent/parse-query.ts`
- Test: `tests/parse-query.test.ts`

**Interfaces:**
- Produces: `export const SearchQuerySchema: z.ZodSchema<{ languages: string[]; keywords: string[]; period: 'today'|'week'|'month'|'all'; minStars: number|null; sortBy: 'stars_delta'|'stars'|'new'; topN: number }>`；`export async function parseSearchQuery(text: string): Promise<SearchQuery>` — 先 LLM（`generateObjectSafe` + 严格 prompt：只允许从文本推断，禁止编造），null 时回退 `fallbackParse(text)` 正则解析（`本周|今天|本月` → period；`python|rust|...` → languages；其余名词 → keywords）。

- [ ] **Step 1: 写 `tests/parse-query.test.ts`** — LLM mock 返回合法对象时透传；LLM 返回 null 时回退解析：`"本周 python 里 ai 相关的"` → `{languages:['python'], keywords:['ai'], period:'week'}`；`"帮我看下最近 star 增长快的 rust 项目"` → `{languages:['rust'], period:'week', sortBy:'stars_delta'}`；无信息文本 `"啊"` → `{period:'week', topN:10, ...defaults}`。
- [ ] **Step 2: FAIL → 实现 → PASS**。LLM prompt 内置示例 ≥ 3 个。
- [ ] **Step 3: Commit** — `feat: nl query parser with llm and regex fallback`

### Task 8: 检索服务

**Files:**
- Create: `src/agent/search.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `SearchQuery`、schema。
- Produces: `export async function searchTrending(q: SearchQuery): Promise<SearchResultItem[]>`（`SearchResultItem = { fullName, description, language, stars, starsDelta, isNew, date, htmlUrl, rank }`）；SQL：trending_entries join repos，period 映射 `date >= now() - interval`，languages 匹配 `language`，keywords 对 `full_name/description/topics` 做 ILIKE OR（jsonb topics 用 `topics::text ILIKE`），排序按 sortBy，limit topN；结果写入 `search_caches`（按 wecom_userid 覆盖）。

- [ ] **Step 1: 写 `tests/search.test.ts`** — 用 PGlite 或 mock db 断言 SQL 参数组装（抽 `buildSearchSql(q): { sql, params }` 纯函数单测各过滤维度组合）；结果 upsert 到 search_caches。
- [ ] **Step 2: FAIL → 实现 → PASS**。
- [ ] **Step 3: Commit** — `feat: trending search with filter dimensions`

### Task 9: 消息回复引擎（接通检索到微信）

**Files:**
- Create: `src/wecom/reply.ts`、修改 `src/wecom/router.ts`（注册 searchHandler）
- Test: `tests/reply.test.ts`

**Interfaces:**
- Produces: `export function formatSearchReply(items: SearchResultItem[]): string`（编号列表：`1. owner/repo ★1234 (+567) — 中文描述`，末尾提示"回复'收藏 N'可收藏并同步 star"）；`export async function handleSearch(msg: InboundMessage): Promise<void>`（parse → search → format → `sendWeComText`；空结果回"没找到…试试换个说法"）。

- [ ] **Step 1: 写 `tests/reply.test.ts`** — format 快照断言（含编号与提示语）；handleSearch 全链 mock：LLM null → 回退解析 → 搜索 2 条 → 发送格式化文本；空结果分支发送引导文案。
- [ ] **Step 2: FAIL → 实现 → 注册进 router → PASS**。
- [ ] **Step 3: Commit** — `feat: search reply engine wired to wecom`

### Task 10: 每日简报生成与推送

**Files:**
- Create: `src/agent/digest.ts`、`api/cron-push-digest.ts`
- Test: `tests/digest.test.ts`

**Interfaces:**
- Produces: `export async function buildDigestForSubscriber(sub): Promise<string>`（取该订阅者偏好的 top10 → LLM 生成每条一句中文"为什么上榜"（新上榜 vs 霸榜对比 stars_delta/is_new），LLM 失败降级为纯模板拼接）；`export async function pushDigests(): Promise<{ sent, failed }>`（遍历 active subscribers，逐个发送，单个失败不中断）；`api/cron-push-digest.ts`：校验 `CRON_SECRET` → `pushDigests()`。

- [ ] **Step 1: 写 `tests/digest.test.ts`** — 偏好过滤生效（languages 为空则全量）；LLM 失败时输出仍包含 repo 列表（模板降级）；`pushDigests` 在第 2 个订阅者发送抛错时仍处理第 3 个，返回计数正确；cron 端点无 secret 返回 401。
- [ ] **Step 2: FAIL → 实现 → PASS**。
- [ ] **Step 3: Commit** — `feat: personalized daily digest with llm and template fallback`

### Task 11: GitHub OAuth 绑定

**Files:**
- Create: `src/github/oauth.ts`、`api/oauth-github.ts`、修改 `router.ts`（注册 bindHandler：回复授权链接）
- Test: `tests/oauth.test.ts`

**Interfaces:**
- Produces: `export function buildAuthorizeUrl(state: wecomUserid): string`（scope=public_repo）；`export async function exchangeCode(code: string): Promise<{ login, token }>`；`api/oauth-github.ts`：GET 带 `code&state` → exchange → AES 加密 token（密钥 `TOKEN_ENCRYPT_KEY`，复用 crypto 思路独立实现 `encryptSecret/decryptSecret`）写入 `subscribers.github_token_enc` 与 `github_login` → 返回中文成功页（提示回微信发"我的收藏"测试）。
- [ ] **Step 1: 写 `tests/oauth.test.ts`** — authorizeUrl 含 client_id/state/scope；exchangeCode mock fetch 成功与 401 分支；encryptSecret/decryptSecret 往返一致；绑定后 subscribers 行更新。
- [ ] **Step 2: FAIL → 实现 → 注册 bindHandler（"绑定"关键词）→ PASS**。
- [ ] **Step 3: Commit** — `feat: github oauth binding with encrypted token storage`

### Task 12: 收藏与 Star 同步

**Files:**
- Create: `src/github/stars.ts`、修改 `router.ts`（注册 favoriteHandler/unfavoriteHandler/listHandler）
- Test: `tests/stars.test.ts`

**Interfaces:**
- Produces: `export async function starRepo(token, fullName): Promise<'ok'|'already'|'auth_failed'>`（`PUT /user/starred/{owner}/{repo}`；401 → auth_failed）；`unstarRepo`（DELETE）；`handleFavorite(msg)`：解析 `收藏 N` → 从 `search_caches` 取第 N 条 → 未绑定则回复"先发'绑定'授权 GitHub"；已绑定则 star + 写 favorites 表 → 回复"✅ 已收藏 owner/repo，已同步到你的 GitHub"；auth_failed 回复"授权已过期，请重新发'绑定'"；`handleUnfavorite`：`取消收藏 N` 从"我的收藏"列表取第 N 条 → unstar + 删行；`handleList`：`我的收藏` 列编号列表。

- [ ] **Step 1: 写 `tests/stars.test.ts`** — starRepo 三分支；handleFavorite 各分支（未绑定/成功/已收藏幂等/auth_failed 提示语）；handleUnfavorite 正确 DELETE 并删库行；N 越界回复"没有第 N 条"。
- [ ] **Step 2: FAIL → 实现 → 注册 router → PASS**。
- [ ] **Step 3: Commit** — `feat: favorite with github star sync`

### Task 13: 订阅开通与偏好设置

**Files:**
- Create: `src/wecom/onboarding.ts`、修改 `router.ts`（未知用户首条消息自动建 subscriber + 欢迎语；注册 `订阅 python,ai`/`退订` 命令）
- Test: `tests/onboarding.test.ts`

**Interfaces:**
- Produces: `export async function ensureSubscriber(msg): Promise<boolean>`（不存在则 insert + 返回 true）；`handleSubscribe`：`订阅 <逗号分隔偏好>` 写 preferences；`handleUnsubscribe`：active=false；欢迎语含功能说明（简报/怎么搜索/收藏前先绑定）。

- [ ] **Step 1: 写 `tests/onboarding.test.ts`** — 新用户首条消息触发 insert 且收到欢迎语；老用户不重复欢迎；订阅命令写 preferences；退订后 `pushDigests` 跳过该用户。
- [ ] **Step 2: FAIL → 实现 → PASS**。
- [ ] **Step 3: Commit** — `feat: onboarding and subscription preferences`

### Task 14: 部署与联调

**Files:**
- Create: `docs/deploy.md`（部署手册）、`.env.example` 更新最终清单、`vercel.json`（如需函数配置）
- Modify: `README.md`（使用说明）

- [ ] **Step 1: 写 `docs/deploy.md`** — 逐步：Neon 建库+迁移；Vercel 导入仓库与 env；企微后台建自建应用（记录 corpid/secret/agentid）→ 配置接收消息回调 URL `https://<domain>/api/wecom-callback` + Token + EncodingAESKey；**开启"微信插件"并把成员加入可见范围**（用户在微信-企业微信插件中订阅）；GitHub OAuth App 回调地址；Actions secrets（NEON_DATABASE_URL、VERCEL_URL、CRON_SECRET、WECOM_*、GITHUB_TOKEN）。
- [ ] **Step 2: 端到端联调清单并逐项验证** — ① 手动 dispatch Actions → Neon 有数据 + 简报送达微信；② 微信里发"本周 rust 的 ai 项目" → 收到编号列表；③ 发"绑定" → 浏览器授权 → 微信确认；④ 发"收藏 1" → GitHub 账号出现该 star；⑤"我的收藏"/"取消收藏 1" → GitHub star 消失；⑥ 断网/LLM 挂掉场景：消息有降级回复。
- [ ] **Step 3: 更新 README + Commit** — `docs: deploy guide and readme`

---

## 验证（整体）

- `npx vitest run` 全绿。
- 联调清单（Task 14 Step 2）六项全过即视为交付。
- 观察指标落地准备：`search_caches` 与 `favorites` 表天然记录检索/收藏行为，MVP 复盘直接查库。
