# 部署与联调手册

从零把 GitHub Trending Agent 部署到 Neon + Vercel + 企业微信 + GitHub Actions，并完成端到端联调。
全文所有示例值均为占位符，**任何地方都不要写入真实密钥**（真实密钥只进 Vercel / Actions / 企微后台的密钥存储）。

**环境地板：Node ≥ 22**（`package.json` `engines.node = ">=22"`；AI SDK v7 的五个依赖同样要求 ≥22，Node 20 已弃用）。

部署顺序建议：**1 Neon → 2 Vercel → 3 企微回调 → 4 GitHub OAuth → 5 Actions secrets → 6 TOKEN_ENCRYPT_KEY → 7 联调清单**。
（回调配置（第 3 步）前必须先完成 Vercel 端 `WECOM_CALLBACK_*` 与 `WECOM_CORP_ID` 的环境变量部署，否则企微 GET URL 验证会 401。）

---

## 1. Neon：建库与迁移

**步骤**

1. 在 <https://neon.tech> 创建 Postgres 项目，复制连接串（形如 `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`）。
2. 本地 `cp .env.example .env`，把连接串填进 `NEON_DATABASE_URL`。
3. 安装依赖：`npm ci`。
4. 执行迁移：`npm run db:migrate`。
   - 实际命令是 `drizzle-kit migrate`（见 `package.json` scripts），迁移 SQL 为 `drizzle/0000_silly_shatterstar.sql`。
   - `drizzle.config.ts` 直接读 `process.env.NEON_DATABASE_URL`；若当前 shell 没有该变量，先 `set -a; source .env; set +a` 再跑，或内联：
     `NEON_DATABASE_URL='postgresql://…' npm run db:migrate`。

**验证**

在 Neon SQL Editor（或任意 psql）执行：

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by 1;
```

应出现 6 张业务表：`repos`、`trending_entries`、`subscribers`、`favorites`、`search_caches`、`kv_cache`（另有 drizzle 迁移记录表）。
`npm run db:migrate` 重复执行安全（已应用的迁移不会重放）。

---

## 2. Vercel：导入仓库与环境变量

**步骤**

1. 在 Vercel Import 本仓库（本项目为纯 API 项目：`api/*.ts` 即 Vercel Node Functions，零框架，无需自定义构建配置）。
2. **Node runtime 必须 ≥ 22**：Vercel 按 `package.json` `engines`（`>=22`）选择运行时版本；部署日志里确认 Node 22.x，**不要**在项目设置里把 Node 降级到 20（AI SDK v7 会直接起不来）。
3. 项目 → Settings → Environment Variables，按下表配置（**全部来自 `src/config.ts` 的 zod 清单**，缺任一必填项会在首次请求抛 `Invalid environment variables: <字段名>`）：

| 环境变量 | 必填/可选 | 归属服务与取值 |
| --- | --- | --- |
| `NEON_DATABASE_URL` | 必填 | Neon：第 1 步的连接串 |
| `LLM_PROVIDER` | 必填 | LLM：`anthropic` \| `openai` \| `deepseek` \| `ali` |
| `LLM_API_KEY` | 必填 | LLM：提供商 API Key |
| `LLM_MODEL` | 必填 | LLM：模型 ID（如 `claude-sonnet-4-5`） |
| `WECOM_CORP_ID` | 必填 | 企业微信：企业 ID（第 3 步记录） |
| `WECOM_AGENT_ID` | 必填 | 企业微信：自建应用 AgentId，**纯数字字符串** |
| `WECOM_SECRET` | 必填 | 企业微信：自建应用 Secret |
| `WECOM_CALLBACK_TOKEN` | 必填 | 企微回调：Token（第 3 步后台自定义） |
| `WECOM_CALLBACK_AES_KEY` | 必填 | 企微回调：EncodingAESKey（43 位；代码按 `Base64Decode(key + "=")` 得 32 字节） |
| `WECOM_ADMIN_USERID` | **可选** | 企微：管理员 userid，仅用于管线失败告警；不配则告警步骤跳过（仅 warning） |
| `GITHUB_CLIENT_ID` | 必填 | GitHub OAuth App（第 4 步） |
| `GITHUB_CLIENT_SECRET` | 必填 | GitHub OAuth App |
| `GITHUB_OAUTH_REDIRECT_URI` | 必填 | 必须是 `https://<domain>/api/oauth-github`（与回调路由、OAuth App 登记值三者完全一致） |
| `GITHUB_TOKEN` | **可选** | GitHub：服务端 token，提高 API 限额（enrich）；不配也可用，只是限额低 |
| `CRON_SECRET` | 必填 | 安全：简报端点 Bearer 口令（生成一串长随机值；Actions 侧同值） |
| `TOKEN_ENCRYPT_KEY` | 必填 | 安全：用户 GitHub token 加密密钥（见第 6 步，**只配 Vercel**） |

4. 部署（Production）。记下**生产域名**（形如 `github-trending-agent.vercel.app`）——它就是第 5 步 Actions secret `VERCEL_URL` 的值。

**验证**（`<domain>` 为生产域名，不含 `https://`）

```bash
# 简报端点：401 {"error":"unauthorized"} → 函数已部署且 Bearer 校验生效
curl -i https://<domain>/api/cron-push-digest

# 企微回调 GET 验签：401 invalid signature → 函数与验签路径在跑（配置好 Token/AESKey 后由企微真正打通）
curl -i https://<domain>/api/wecom-callback

# OAuth 回调：400 HTML（缺 code/state）→ 路由存在
curl -i https://<domain>/api/oauth-github
```

> `VERCEL_URL` 作为 Actions secret 时**只填域名**（`myapp.vercel.app`），不带 `https://` 前缀、不带尾斜杠——`daily.yml` 会拼成 `https://${VERCEL_URL}/api/cron-push-digest`。

---

## 3. 企业微信管理后台：自建应用与回调

**步骤**（管理后台 <https://admin.work.weixin.qq.com>）

1. 「我的企业 → 企业信息」记录**企业 ID**（corpid）→ 存入 Vercel `WECOM_CORP_ID`。
2. 「应用管理 → 自建 → 创建应用」：填名称、logo、可见范围（先覆盖测试成员）。创建后记录 **AgentId** 与 **Secret** → 分别存入 `WECOM_AGENT_ID`（纯数字字符串）、`WECOM_SECRET`。
3. 应用详情 →「接收消息 → 接收消息服务器配置 → 设置 API 接收」：
   - **URL**：`https://<domain>/api/wecom-callback`
   - **Token**：自定义随机串 → 与 Vercel `WECOM_CALLBACK_TOKEN` **完全一致**
   - **EncodingAESKey**：自定义（43 位）→ 与 Vercel `WECOM_CALLBACK_AES_KEY` **完全一致**
   - 保存时企微会向该 URL 发起 GET URL 验证；**保存成功即验证通过**（这是 crypto 配置三元组的活体验证，见第 8 节要点 2）。
4. 「我的企业 → 微信插件」：**开启「允许成员使用微信插件」**，并把目标成员加入**可见范围**（应用可见范围 + 微信插件侧）。用户在微信中通过「企业微信插件」入口绑定企业后，即可在微信里收发该应用的消息——搜索回复、每日简报都从这里送达。

**验证**

用成员账号给应用发一条首条文本（如「你好」）→ 收到欢迎语（`你好！我是 GitHub 热榜助手，已为你开通订阅。…`）。
同时：企微后台「接收消息」无报错记录，Vercel Logs 能看到对应的 POST `/api/wecom-callback`（先回 200 空串、异步处理）。
若保存回调 URL 时报验证失败 → 核对 Token / EncodingAESKey / corpid 三者与 Vercel env 是否逐字一致，并确认该 env 已随部署生效。

---

## 4. GitHub OAuth App

**步骤**（GitHub → Settings → Developer settings → OAuth Apps → New OAuth App）

1. **Authorization callback URL**：`https://<domain>/api/oauth-github`（对应路由 `api/oauth-github.ts`）。GitHub 会严格比对授权请求里的 `redirect_uri`，此处与 env 必须逐字一致。
2. 创建后记录 **Client ID**、生成 **Client secret** → 存入 Vercel `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。
3. Vercel `GITHUB_OAUTH_REDIRECT_URI` = `https://<domain>/api/oauth-github`（与第 1 条完全相同）。
4. 授权 scope 由代码固定为 `public_repo`（最小权限，star 仓库够用），后台无需另配。

**验证**

部署 env 后，在微信里给应用发送「**绑定**」→ 收到回复，含 `https://github.com/login/oauth/authorize?…` 链接；点击进入 GitHub 授权页**不报 `redirect_uri` mismatch**。

---

## 5. GitHub Actions secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| secret | 必填/可选 | 说明 |
| --- | --- | --- |
| `NEON_DATABASE_URL` | 必填 | 与 Vercel 同一连接串（scraper/enrich 直接入库） |
| `VERCEL_URL` | 必填 | 生产域名，**无 `https://` 前缀**（见第 2 步） |
| `CRON_SECRET` | 必填 | 与 Vercel `CRON_SECRET` **同值**（curl 简报端点的 Bearer） |
| `WECOM_CORP_ID` | 必填 | 失败告警取 access_token |
| `WECOM_AGENT_ID` | 必填 | **必须存纯数字字符串**——`daily.yml` 告警 payload 用 `jq … tonumber`，存非数字会把告警步骤本身打挂 |
| `WECOM_SECRET` | 必填 | 失败告警取 access_token |
| `WECOM_ADMIN_USERID` | **可选** | 不配置时失败告警步骤跳过（仅打 warning，不算失败） |
| `GITHUB_TOKEN` | **可选** | enrich 补 topics 用，提高 GitHub API 限额；不配置时 workflow 取到 GitHub 自动注入的默认令牌（本 workflow 权限 `contents: read`，查公共仓库 API 够用） |

**zod 占位策略**（`daily.yml` env 段，照抄自工作流注释）：
`src/config.ts` 的 zod 校验是**全量必填**——即便 scraper/enrich CLI 只实际消费 `NEON_DATABASE_URL`（和可选的 `GITHUB_TOKEN`），缺任一必填项都会在 `db()` 初始化时抛错。因此 workflow 对**未被本管线消费的必填项**统一填字面量 `placeholder-not-used-in-ci`：

- 走占位（**绝不要**配成 Actions secrets）：`LLM_PROVIDER`、`LLM_API_KEY`、`LLM_MODEL`、`WECOM_CALLBACK_TOKEN`、`WECOM_CALLBACK_AES_KEY`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_OAUTH_REDIRECT_URI`、`TOKEN_ENCRYPT_KEY`
- 走真实 secrets（管线/告警实际消费）：上表 8 项

这样把真实密钥的暴露面收敛到 CI 作业之外（OAuth/回调/加密密钥只存在 Vercel 端）。

**验证**

Actions → 「每日热榜管线」→ Run workflow（`workflow_dispatch`）。跑完后：
- 「触发简报推送」步骤的 curl 返回 200 + `{"sent":…,"failed":…}`；
- 若人为把某步弄挂，且配置了 `WECOM_ADMIN_USERID`，管理员应收到企微告警文本（含 Run URL），且工作流日志里告警步骤 `errcode == 0` 断言通过。

---

## 6. TOKEN_ENCRYPT_KEY

- **生成**：一串足够长的随机值，例如 `openssl rand -hex 32`（或任意长随机字符串）。
- **配置位置：只配 Vercel**（Production）。`daily.yml` 对它填占位字面量，**永远不要**把它设为 Actions secret。
- **作用**：`sha256(TOKEN_ENCRYPT_KEY)` 派生 AES-256-GCM 密钥，加密入库的用户 GitHub token（`subscribers.github_token_enc`）。
- **轮换代价**：更换该值后，已入库密文全部解不开——用户「收藏 N」会收到 `授权已过期，请重新发'绑定'`，**需要所有用户重新发「绑定」完成 OAuth 重新授权**。没有别的数据会丢。
- **验证**：完成一次绑定（联调第 ③ 项）后查库：
  `select github_login, left(github_token_enc, 12) from subscribers;`
  —— `github_login` 为 GitHub 用户名，`github_token_enc` 是 base64 密文片段；**绝不应**出现 `gho_`/`ghp_` 开头的明文 token。

---

## 7. 端到端联调清单（六项全过即视为交付）

### ① 手动跑通每日管线：数据入库 + 简报送达微信

- **操作**：Actions → 「每日热榜管线」→ Run workflow（`workflow_dispatch`）。
- **预期观察**：
  1. 三个步骤（抓取 / 补全 / 推送）全绿；推送步骤 curl 返回 `{"sent":N,"failed":0}`（N ≥ 1，`failed` 必须为 0）。
  2. Neon：`select count(*) from trending_entries where date = current_date;` 大于 0（6 个榜单：总榜 + 5 语言）；`repos.topics` 有非空数组（enrich 生效）。
  3. 微信：`active = true` 的订阅者收到**每日简报**（top10 编号列表，`N. owner/repo ★…`，每条附一句「为什么上榜」；LLM 挂掉时仍有纯模板仓库列表）。
  4. Vercel Logs：`/api/cron-push-digest` 一次 200 记录。

### ② 自然语言搜索 → 编号列表

- **操作**：微信里发「**本周 rust 的 ai 项目**」。
- **预期观察**：
  1. 收到编号回复：每行形如 `1. owner/repo ★1234 (+567) — 中文描述`（新上榜带 `（新上榜）`），末行固定提示 `回复'收藏 N'可收藏并同步 star`。
  2. Neon：`search_caches` 该用户行的 `results` 数组被覆盖写（`select results from search_caches where wecom_userid = '<测试用户>';`），序号与回复列表一一对应——这是下一步「收藏 1」的前提。
  3. 用下一条消息「我的收藏」的序号口径核对：列表顺序稳定。

### ③ 「绑定」→ 浏览器授权 → 微信确认

- **操作**：发「**绑定**」→ 点开回复里的授权链接 → 浏览器登录 GitHub 并授权（scope 仅 `public_repo`）→ 页面显示 `GitHub 绑定成功 / 已绑定 GitHub 账号：<login>` → 回微信发「我的收藏」。
- **预期观察**：
  1. 「绑定」回复文案为 `请点击以下链接完成 GitHub 授权（授权范围仅 public_repo…）` + 授权 URL + 尾句提示。
  2. 浏览器成功页含 `已绑定 GitHub 账号：` 与真实 login；授权页不报 redirect_uri 错误。
  3. Neon：`subscribers.github_login` = login，`github_token_enc` 为密文（见第 6 步验证 SQL）。
  4. 回微信发「我的收藏」→ 不再出现 `先发'绑定'授权 GitHub` 引导（空态文案则正常）。

### ④ 「收藏 1」→ GitHub 出现 star

- **操作**：先完成一次搜索（②），再发「**收藏 1**」。
- **预期观察**：
  1. 微信回复 `✅ 已收藏 <owner/repo>，已同步到你的 GitHub`。
  2. GitHub 个人页（github.com/<login>?tab=stars）出现该仓库的 star。
  3. Neon：`favorites` 新增行且 `starred_on_github = true`（重复发「收藏 1」幂等，不报错、不重复行——唯一约束 `(wecom_userid, full_name)` + upsert）。
  4. 未搜索就收藏（无 `search_caches` 行）或序号越界 → 回复 `没有第 N 条`，不写库。

### ⑤ 「我的收藏」/「取消收藏 1」→ star 消失

- **操作**：发「**我的收藏**」→ 按列表序号发「**取消收藏 1**」。
- **预期观察**：
  1. 「我的收藏」回编号列表（`owner/repo` + 收藏日期）；空列表回 `你还没有收藏任何项目。…`。
  2. 「取消收藏 1」回 `已取消收藏 <owner/repo>`。
  3. GitHub：该仓库 star **消失**。
  4. Neon：对应 `favorites` 行被**删除**（`select count(*) from favorites where full_name = '…';` 为 0）；GitHub 侧未确认成功（如 401）时行不删、回引导文案——属正常降级。

### ⑥ 降级路径：LLM 挂掉 / 无效查询

- **操作 A（LLM 不可用）**：把 Vercel `LLM_API_KEY` 临时改错（或 LLM 服务不可达）→ 再发一次搜索「本周 rust 的 ai 项目」；再手动 dispatch 一次管线看简报。
- **预期 A 观察**：
  1. 搜索**仍返回编号列表**——`parseSearchQuery` 走 `fallbackParse` 正则回退（语言别名、`本周/今天/本月` 时间词、关键词仍被提取），不是报错。
  2. 简报**仍列出仓库**（纯模板降级：无「为什么上榜」句子，repo 列表永远存在）。
  3. 修复 key 后回复恢复带 LLM 增强的解析结果。
- **操作 B（无效/乱写查询）**：发一条无有效条件的文本（如「啊啊啊乱写一通」）。
- **预期 B 观察**：解析/检索兜底链给出中文回复——空结果时为 `没找到符合条件的项目，试试换个说法…`，解析或发送异常时为 `抱歉，处理你的查询时出了点问题，请稍后再试。`；**任何输入都有中文回复，绝无静默**（回调端点已先回 200，处理在异步进行，回复可能有数秒延迟）。

---

## 8. 部署后验证要点（SDD 台账累积项）

1. **Neon 双跑幂等冒烟**：本地对同一日期跑两次抓取 CLI（`npx tsx src/scraper/run-scraper.ts`）→ 第二次 `trending_entries` 行数**不增加**（唯一约束 `trending_entries_date_period_language_full_name_unique` 兜底；这是台账移交本任务的必做项）。
2. **官方企微加密样例活体验证**：crypto 实现已按官方 QDG6eK 样例向量在单测钉死；后台保存回调配置时 **GET URL 验证必须成功**——活体通过即证明 Token / EncodingAESKey / corpid 三元组与 Vercel env 配置接线一致（单测过 ≠ 配置对）。
3. **live `workflow_dispatch` 全链路跑一次**：即第 7 节 ①，三步全绿 + 简报真实送达微信，才算管线闭环。
4. **`WECOM_AGENT_ID` 必须存纯数字字符串**：`daily.yml` 告警 payload 用 `jq … tonumber`；Vercel 端代码也做 `Number(env.WECOM_AGENT_ID)`——两侧都要求纯数字（如 `1000001`），存带引号/字母的值会把失败告警本身打挂。
5. **Vercel Node runtime ≥ 22**：`package.json` engines 地板 + AI SDK v7 依赖硬要求；部署日志确认 22.x，别在项目设置里回退到 20。
6. **真库验证 distinct-on 去重**：选一个同时出现在总榜（`language='all'`）与语言榜的仓库，搜该语言 → 结果里该 `owner/repo` **只出现一次**（单测只能钉 SQL 形状与 JS 安全网，真库执行属本任务验证）。
7. **`search_caches` 写入非原子**：当前为 delete + insert 两次 `await`（已记账未改）。如并发搜索时偶发丢缓存（「收藏 N」读到旧列表），改用 `db.batch` 一轮原子提交；MVP 可接受，先知悉即可。
8. **`subscribers.display_name` 以空串占位**：schema 为 `NOT NULL` 无默认值，onboarding 插入 `''`（企微回调只带 userid，暂无名称来源，且无任何运行时读取方）。可选后续迁移改为可空，不阻塞 MVP。
9. **本地跑 CLI 报 `fetch failed`（TLS 拦截环境）**：部分企业网络/安全软件会对 HTTPS 做中间人拦截——curl 能通（用 Windows 证书库）但 Node fetch 报 `unable to verify the first certificate`。本地执行时加 `NODE_OPTIONS="--use-system-ca"` 即可（如 `NODE_OPTIONS="--use-system-ca" npx tsx src/scraper/run-scraper.ts`）；GitHub Actions 托管 runner 无此问题，管线不受影响。

---

## 附：观察指标落地准备

- `search_caches`（每用户覆盖写）天然记录**检索行为**；
- `favorites`（含 `starred_on_github` 同步状态）天然记录**收藏行为**。

MVP 复盘直接查库即可，无需另埋点。
