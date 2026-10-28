# 部署与联调手册

从零把 GitHub Trending Agent 部署到 Neon + Vercel + 企业微信 + GitHub Actions，并完成端到端联调。
全文所有示例值均为占位符，**任何地方都不要写入真实密钥**（真实密钥只进 Vercel / Actions / 企微后台的密钥存储）。

**环境地板：Node ≥ 22**（`package.json` `engines.node = ">=22"`；AI SDK v7 的五个依赖同样要求 ≥22，Node 20 已弃用）。

部署顺序建议：**1 Neon → 2 Vercel → 3 企微回调 → 4 GitHub OAuth → 5 Actions secrets → 6 TOKEN_ENCRYPT_KEY → 7 联调清单**。
（回调配置（第 3 步）前必须先完成 Vercel 端 `WECOM_CALLBACK_*` 与 `WECOM_CORP_ID` 的环境变量部署，否则企微 GET URL 验证会 401。）

![数据流：定时抓取 → 入库 → 每小时快照（一轮模型）→ 企微与邮箱双通道](assets/flow.svg)

---

## 1. Neon：建库与迁移

**步骤**

1. 在 <https://neon.tech> 创建 Postgres 项目，复制连接串（形如 `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`）。
2. 本地 `cp .env.example .env`，把连接串填进 `NEON_DATABASE_URL`。
3. 安装依赖：`npm ci`。
4. 执行迁移：`npm run db:migrate`。
   - 实际命令是 `drizzle-kit migrate`（见 `package.json` scripts），迁移 SQL 为 `drizzle/0000_silly_shatterstar.sql`、`0001_living_the_leader.sql`（新增 `subscribers.last_digest_at`，供简报推送时间/间隔门控使用）、`0002_email_subscribers.sql`（邮箱订阅双确认）、`0003_dashing_vin_gonzales.sql`（新增 `subscribers.llm_base_url / llm_model / llm_key_enc`，自备 AI Key）、`0004_agent_runs_tool_calls.sql`（新增 `agent_runs` 与 `tool_calls`，运行日志与工具流水从 `kv_cache` 迁到正式表）。
   - `drizzle.config.ts` 直接读 `process.env.NEON_DATABASE_URL`；若当前 shell 没有该变量，先 `set -a; source .env; set +a` 再跑，或内联：
     `NEON_DATABASE_URL='postgresql://…' npm run db:migrate`。
   - **⚠ 迁移账本的时间戳陷阱**：`drizzle-kit migrate` 只应用 journal 里 `when` **大于** `drizzle.__drizzle_migrations` 中最大 `created_at` 的迁移，且无论跳过多少条都会打印 "migrations applied successfully"。本仓库 `0002` 的 `when` 曾被人为设到未来（`1793200000000` ≈ 2026-10-28），导致之后生成的迁移被静默跳过；现已把 `0002` / `0003` 的 `when` 归一化到过去（`1792900000000` / `1793000000000`）。生产账本在 **2026-10-27 应用 0004 后最大 `created_at` 为 `1793200000002`**（应用前是 `1793200000001`）。`0004` 的 `when` 设为 `1793200000002` 而不是真实生成时间，就是为了让已经存在未来账本行的生产库仍然应用它；**后续迁移必须继续取大于上一条的值**。**新增迁移后必须确认它真的执行了**：
     ```sql
     select id, created_at from drizzle.__drizzle_migrations order by id;
     ```
     条数应等于 `drizzle/meta/_journal.json` 的 `entries` 数；若少了，把新迁移的 `when` 改成大于上一条的值再跑一次（不要手工改生产账本）。
   - **0004 已应用到生产（2026-10-27）。** 在尚未迁移的新环境里系统仍然可用：`src/obs/trace.ts` 写 `agent_runs` 失败会退回 `kv_cache`（7 天 TTL），`api/trace.ts` 也合并两个数据源；但 `/api/metrics` 这类按表聚合的查询会失败，所以上线度量前必须先迁移。

**验证**

在 Neon SQL Editor（或任意 psql）执行：

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by 1;
```

应出现 9 张业务表：`repos`、`trending_entries`、`subscribers`、`favorites`、`search_caches`、`kv_cache`、`email_subscribers`、`agent_runs`、`tool_calls`（另有 drizzle 迁移记录表）。
`npm run db:migrate` 重复执行安全（已应用的迁移不会重放）。

**一条命令做同样的检查（推荐）**：

```bash
npm run db:audit
```

脚本只发 `SELECT`，不写任何数据。它比上面那条 SQL 多查四类东西：其他 schema 下的关系（别人可能在 `app`/`auth` 里建过表）、外来迁移工具的痕迹（`_prisma_migrations`、`knex_migrations` 等）、同库还在连的其他客户端（`pg_stat_activity`），以及我们 9 张表的**列结构**是否仍与 `drizzle/meta/0004_snapshot.json` 一致。最后给一个判定：

| 判定 | 含义 | 退出码 |
| --- | --- | --- |
| `CLEAN` | 只有这 9 张表，结构一致，迁移账本 5 行 | 0 |
| `EXTRA_EMPTY` | 多出别人的表，但都是空表 | 0 |
| `EXTRA_WITH_DATA` | 多出别人的表且里面有数据——这个库被另一个项目用过 | 1 |
| `MISSING_OR_ALTERED` | **我们自己的表**缺失、列被改、或账本落后（有人跑过 `db:push`/reset） | 2 |
| `INCONCLUSIVE` | 有必要的检查没跑成（权限不足/超时）——**不能当成干净** | 2 |

后几种的含义完全不同：`EXTRA_*` 是历史遗留，`MISSING_OR_ALTERED` 才是故障，`INCONCLUSIVE` 是「没查清」。处理建议见下方「库污染怎么处理」。

### ⚠ 本库已知情况（2026-10-28 审计）与禁止事项

生产库 `neondb` 里**同时住着另一个项目的 18 张表**：`tenants`、`rooms`、`sessions`、`session_assignments`、`bookings`、`booking_intake_refs`、`dms`、`dm_shifts`、`dm_run_events`、`dm_runs`、`dm_leaves`、`scripts`、`script_stages`、`public_scripts`、`import_runs`、`access_requests`、`search_usage_daily`、`usage_global_daily`。其中 `tenants`(1)、`dm_shifts`(42)、`script_stages`(20) 等**有真实数据**，是活的数据，不是空壳。

我们的 9 张表与它们**完全不重叠**（表名、序列、迁移账本都独立），所以当前运行不受影响。真正的风险只有一个：

> **绝对不要在这个数据库上执行 `drizzle-kit push`（或任何 `push` 类命令）。**

`push` 会把「snapshot 里有」和「库里有」做差集，把 snapshot 里没有的表当成多余对象**删掉**——也就是上面那 18 张别人的表。`db:migrate` 是安全的：它只按账本增量执行我们自己的 SQL，不碰任何其他对象。改完 schema 的正确流程是 `db:generate` → 审 SQL → `db:migrate`，不是 `push`。

彻底隔离的做法（推荐，10 分钟）：Neon 新建 project/branch → `npm run db:migrate` → 迁有状态的 4 张表（`subscribers`、`favorites`、`search_caches`、`kv_cache`，合计数百行）→ 换 Vercel 的 `NEON_DATABASE_URL` → 重新部署。

**库污染怎么处理**（按风险从低到高）：

1. `EXTRA_EMPTY`：什么都不做。空表不影响任何东西，删别人的表反而有风险。
2. `EXTRA_WITH_DATA` + 那个项目已废弃：确认后删除，删前先 `pg_dump` 那几张表。
3. `EXTRA_WITH_DATA` + 那个项目还在用：**不要动别人的表**。**动我们**——给本项目换新库（见上）。
4. `MISSING_OR_ALTERED`：先看账本差几行——差 1 行补跑迁移即可；表结构被改形要逐列修，**不要**直接 `db:push`。
5. `INCONCLUSIVE`：先解决那道跑不通的检查（通常是权限），再重跑。**不要**把它当 `CLEAN`。

红线：**绝不 `DROP` 别人的表**；**绝不手改 `drizzle.__drizzle_migrations`**；**这个库上绝不跑 `db:push`**。

---

## 2. Vercel：导入仓库与环境变量

**步骤**

1. 在 Vercel Import 本仓库（本项目为纯 API 项目：`api/*.ts` 即 Vercel Node Functions，零框架，无需自定义构建配置）。
2. **Node runtime 必须 ≥ 22**：Vercel 按 `package.json` `engines`（`>=22`）选择运行时版本；部署日志里确认 Node 22.x，**不要**在项目设置里把 Node 降级到 20（AI SDK v7 会直接起不来）。
3. 项目 → Settings → Environment Variables，按下表配置（**全部来自 `src/config.ts` 的 zod 清单**，缺任一必填项会在首次请求抛 `Invalid environment variables: <字段名>`）：

| 环境变量 | 必填/可选 | 归属服务与取值 |
| --- | --- | --- |
| `NEON_DATABASE_URL` | 必填 | Neon：第 1 步的连接串 |
| `LLM_PROVIDER` | 必填 | LLM：`anthropic` \| `openai` \| `deepseek` \| `ali` \| `mimo` \| `opencode` \| `zhipu` \| `moonshot` \| `doubao` \| `siliconflow` \| `openrouter` \| `gemini` \| `ollama` \| `custom`（常见厂商的内置 endpoint 见下表；不区分大小写，前后空格会被裁掉） |
| `LLM_API_KEY` | 必填 | LLM：提供商 API Key（`ollama` 本地部署可填任意非空串） |
| `LLM_MODEL` | 必填 | LLM：模型 ID（如 `claude-sonnet-4-5`、`glm-4.6`、`kimi-k2-0905-preview`、`doubao-seed-1-6`） |
| `LLM_BASE_URL` | **可选** | LLM：覆盖或自定义 OpenAI 兼容 endpoint（如 `https://your-proxy.example.com/v1`）。`LLM_PROVIDER=custom` 时**必填**；其他提供商填了就覆盖内置 endpoint |
| `REPO_SUMMARY_MODE` | **可选** | 仓库中文简介：缺省/`llm` = 批量调 LLM 生成并全局缓存（`kv_cache` key `repo-zh:<fullName>`，180 天）；设 `off` = 不生成简介，一律用英文 description 截断 40 字符。注意每日快照里的 Abstract 仍会调用一次模型，所以是「每天一次」而不是零 token |
| `WECOM_CORP_ID` | 必填 | 企业微信：企业 ID（第 3 步记录） |
| `WECOM_AGENT_ID` | 必填 | 企业微信：自建应用 AgentId，**纯数字字符串** |
| `WECOM_SECRET` | 必填 | 企业微信：自建应用 Secret |
| `WECOM_CALLBACK_TOKEN` | 必填 | 企微回调：Token（第 3 步后台自定义） |
| `WECOM_CALLBACK_AES_KEY` | 必填 | 企微回调：EncodingAESKey（43 位；代码按 `Base64Decode(key + "=")` 得 32 字节） |
| `WECOM_ADMIN_USERID` | **可选** | 企微：管理员 userid，仅用于管线失败告警；不配则告警步骤跳过（仅 warning） |
| `WECOM_RELAY_URL` | **可选** | 出站中转地址：配置后 `message/send` 改走固定 IP 中转，规避「企业可信 IP 白名单」（`gettoken` 仍直连） |
| `WECOM_RELAY_SECRET` | **可选** | 中转共享密钥，与中转服务约定；未配 `WECOM_RELAY_URL` 时忽略 |
| `GITHUB_CLIENT_ID` | 必填 | GitHub OAuth App（第 4 步） |
| `GITHUB_CLIENT_SECRET` | 必填 | GitHub OAuth App |
| `GITHUB_OAUTH_REDIRECT_URI` | 必填 | 必须是 `https://<domain>/api/oauth-github`（与回调路由、OAuth App 登记值三者完全一致） |
| `GITHUB_TOKEN` | **可选** | GitHub：服务端 token，提高 API 限额（enrich）；不配也可用，只是限额低 |
| `CRON_SECRET` | 必填 | 安全：简报端点 Bearer 口令（生成一串长随机值；Actions 侧同值） |
| `TOKEN_ENCRYPT_KEY` | 必填 | 安全：用户 GitHub token 加密密钥（见第 6 步，**只配 Vercel**） |
| `RESEND_API_KEY` | **可选** | 邮箱备用通道：Resend API Key（第 9 步）；不配则邮箱入口显示「即将开放」、cron 跳过邮件 |
| `EMAIL_FROM` | **可选** | 邮箱：发件人，须为 Resend 已验证域名下的地址，如 `GitHub 热榜 <digest@mail.example.com>` |
| `PUBLIC_BASE_URL` | **可选** | 邮箱/落地页：站点根地址（无尾斜杠），用于邮件里的确认/设置/退订链接；缺省回退请求 Host |
| `WECOM_JOIN_QR_URL` | **可选** | 落地页：「加入企业」二维码地址；缺省用仓库内的 `docs/assets/wecom-join-qr.png` |
| `WECOM_PLUGIN_QR_URL` | **可选** | 落地页：「微信插件」二维码地址；缺省用仓库内的 `docs/assets/wecom-plugin-qr.png` |
| `WECOM_APP_NAME` | **可选** | 落地页：应用显示名（缺省 `GitHub 热榜`） |
| `WECOM_ACCEPTING` | **可选** | 落地页名额门控：`true`/`false` 显式覆盖，优先于成员数探测 |
| `WECOM_MEMBER_LIMIT` | **可选** | 名额上限（默认 `100`；企业认证后按后台上限调整） |

**LLM 提供商对照表**（除 `anthropic` / `mimo` 走 Anthropic 协议外，其余均走 OpenAI 兼容协议；任一 `LLM_BASE_URL` 都可覆盖）：

| `LLM_PROVIDER` | 内置 endpoint | 常见 `LLM_MODEL` 示例 |
| --- | --- | --- |
| `anthropic` | Anthropic 官方 | `claude-sonnet-4-5` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `deepseek` | DeepSeek 官方 | `deepseek-chat` |
| `ali` | 阿里云百炼（`@ai-sdk/alibaba`） | `qwen-plus` |
| `mimo` | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-flash` |
| `opencode` | OpenCode Go 订阅 `https://opencode.ai/inference/go/openai/v1`（chat/completions） | `deepseek-v4.1-flash`、`glm-5.3-flash`、`kimi-k3` |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
| `moonshot` | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| `doubao` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6`（或推理接入点 ID） |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-32B` |
| `openrouter` | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| `ollama` | `http://localhost:11434/v1`（本地/自托管） | `qwen3:8b` |
| `custom` | 由 `LLM_BASE_URL` 指定（必填） | 任何 OpenAI 兼容网关 |

> 只用到结构化输出（`generateObject`）与短文本生成：换成便宜模型即可，`REPO_SUMMARY_MODE=off` 更能把简介成本降到零。模型是否支持 JSON 输出由厂商决定，首次切换后看 Vercel 日志里是否出现 `[llm] provider=… model=…`（有输出即调用成功）。

> **OpenCode Go**：在 <https://opencode.ai/console/login> 订阅 Go（$10/月，仅限单成员 workspace）并创建 API Key，填 `LLM_PROVIDER=opencode`、`LLM_MODEL=deepseek-v4.1-flash`、`LLM_BASE_URL` **留空**。改用按量付费余额时只把 `LLM_BASE_URL` 设为 `https://opencode.ai/inference/openai/v1`。该网关只提供 OpenAI 兼容 chat/completions，代码里固定走 `.chat()`；若模型报区域限制，到 Console → Settings › Privacy 把 Regions 设为 `Global`。

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

> **推送有两个触发源**：`vercel.json` 的 Vercel Cron `0 1 * * *`（UTC，= 北京 09:00）负责默认时段的准点触发，Vercel 会带上 `Authorization: Bearer $CRON_SECRET`（前提是该项目已配置同名环境变量）；GitHub Actions 的 `digest-hourly.yml` 作为其余时段的兜底。GitHub 的 schedule 实测会整段丢触发（2026-10-28 出现过 09:17–13:17 连续五个 tick 不跑），**不要**把它当准点保障。
>
> `VERCEL_URL` 作为 Actions secret 时**只填域名**（`myapp.vercel.app`），不带 `https://` 前缀、不带尾斜杠——`digest-hourly.yml` 会拼成 `https://${VERCEL_URL}/api/cron-push-digest`（`daily.yml` 抓取/补全之后还会**兜底触发一次**简报推送；`pushDigests` 的三重门控保证与小时触发不重复）。

---

## 3. 企业微信管理后台：自建应用与回调

**步骤**（管理后台 <https://admin.work.weixin.qq.com>）

1. 「我的企业 → 企业信息」记录**企业 ID**（corpid）→ 存入 Vercel `WECOM_CORP_ID`。
2. 「应用管理 → 自建 → 创建应用」：填名称、logo、可见范围（先覆盖测试成员）。创建后记录 **AgentId** 与 **Secret** → 分别存入 `WECOM_AGENT_ID`（纯数字字符串）、`WECOM_SECRET`。
   - **logo 直接用** [docs/assets/icon-750.png](assets/icon-750.png)（750×750 PNG，原创图标，可商用）。
   - **应用介绍**（4–120 字）：`每天一份中文 GitHub 热榜简报，直接在微信里收、在微信里问。`（33 字）
   - **功能介绍**（4–120 字）：`每天抓取 GitHub Trending 并写成中文简介，按你设定的时间和间隔推送。会话里可直接提问找项目，例如「本周 rust 的 ai 项目」；发「帮助」查看全部指令。绑定 GitHub 后可收藏仓库并同步 star。`（111 字）
   - 两段都只讲「能干什么」，不写安装步骤——「无需下载企业微信」那类话属于落地页 `/api/join`。
3. 应用详情 →「接收消息 → 接收消息服务器配置 → 设置 API 接收」：
   - **URL**：`https://<domain>/api/wecom-callback`
   - **Token**：自定义随机串 → 与 Vercel `WECOM_CALLBACK_TOKEN` **完全一致**
   - **EncodingAESKey**：自定义（43 位）→ 与 Vercel `WECOM_CALLBACK_AES_KEY` **完全一致**
   - 保存时企微会向该 URL 发起 GET URL 验证；**保存成功即验证通过**（这是 crypto 配置三元组的活体验证，见第 8 节要点 2）。
4. 「我的企业 → 微信插件」：**开启「允许成员使用微信插件」**，并把目标成员加入**可见范围**（应用可见范围 + 微信插件侧）。用户在微信中通过「企业微信插件」入口绑定企业后，即可在微信里收发该应用的消息——搜索回复、每日简报都从这里送达。

**应用图标**

- 上传 [assets/icon-750.png](assets/icon-750.png)（750×750 PNG）；源文件是 [assets/icon.svg](assets/icon.svg)。改了造型后用同一份 SVG 重新导出：临时 `npm i -D @resvg/resvg-js` → `npx --yes tsx` 或一小段 Node 脚本渲染 750 / 512 两档，用完 `npm uninstall`（PNG 只用于上传后台，应用运行时不依赖该包）。
- 微信插件会话、聊天列表会把它当头像显示（圆形或圆角方形裁切）：图形主体（天线、眼睛、微笑、气泡尾巴）都落在中心半径 205 的安全区内，裁切不会缺角。
- **「我的企业 → 企业信息 → 企业 logo」是窄横幅，不要传方形头像**（会只显示中间一小块）。字标上写的是**企业名**，所以先去「我的企业 → 企业信息 → 企业名称」把名字定好，再从 [assets/logo-lockup.svg](assets/logo-lockup.svg) 导出 PNG 上传：`logo-lockup-960.png`（960×320，3:1）或 `logo-lockup-1200x300.png`（1200×300，4:1），按上传框的「建议尺寸」挑最接近的一档。两张都是透明底，白底后台里没有色块。
  - 导出方法：临时 `npm i -D @resvg/resvg-js`，按 SVG 自己的 `width`/`height` 渲染即得 960×320；要 4:1 只把这两个属性改成 `width="1200" height="300"`、**`viewBox` 保持 `0 0 960 320`**，默认的 `preserveAspectRatio="xMidYMid meet"` 会按高度等比缩小并左右补透明边。用完 `npm uninstall`。
  - 字标里**不写任何发送时间**：推送时间每位用户可改，邮箱通道还会分批发，静态图写死时间就是错的承诺（`tests/brand.test.ts` 会拦）。
- 横版字标的图标与 [assets/icon.svg](assets/icon.svg) 同源，`tests/brand.test.ts` 会逐字比对两者的图标组——改图标时两处必须一起改。
- 原创几何图形（深海军蓝底 `#0B1220` + 蓝青渐变气泡机器人 `#3B82F6 → #2563EB`，青色天线点 `#22D3EE`），不含第三方商标/字体/图库素材，可商用；落地页与 favicon 用的是同一造型的内联副本（[src/brand.ts](../src/brand.ts)）。
- 品牌色的语义分工：**蓝色是品牌色**（按钮、链接、卡片描边）；**绿色只用于数据**（邮件里的「+N 今日 / 新上榜」沿用 GitHub 的增长绿 `#1a7f37`），不要把它们互换。

**验证**

用成员账号**首次进入应用**（企微工作台点开该应用，触发 `enter_agent` 事件）或给应用发一条首条文本（如「你好」）→ 先收到欢迎语（3 行：`你好！我是 GitHub 热榜助手，已为你自动开通每日简报（默认每天 09:00 北京时间推送）。…`），紧接一条**今日简报**（news 卡片，最多 8 篇：首篇 GitHub OG 大图，其余为文字卡片、不发图；每篇标题为 `🔥/🆕 序号. owner/repo ★星标 (+增量)｜≤10 字短简介`）。
再次进入应用 / 再发消息**不会**重复送礼包（订阅者行已存在）。

> **消息类型：实测过，简报用 news 卡片，纯文本只做兜底。** 2026-10-28 用临时探针在个人微信（微信插件）逐条实发，不是照文档推断：
> - `text` / `textcard` / `news` 都能显示；`markdown` 仍然不渲染，只显示「暂时不支持此消息类型，请在企微中查看」。
> - `news` 一条最多 **8 篇**（第 9 篇被 `45008` 拒绝）；多篇布局里 **description 完全不显示**，标题在仓库名与星标之后约 10–12 个汉字处被裁。
> - `textcard` 一次只能放一个仓库，`btntxt`（按钮文字）不显示——不适合多仓库简报。
> - **多图不可靠**：微信是打开会话时才逐张抓 `picurl`，连静态 CDN 的图也会一张一张慢慢出、偶尔失败（实测 8 张里 1–3 张长期灰着；动态函数、头像代理、静态色块都试过，瓶颈在微信侧）。**所以只有第 1 篇带图（GitHub OG，实测秒开），其余 7 条不发图**。
>
> 因此：简报 = news（8 篇封顶、仅首篇 OG、标题 ≤128 字节、短简介 ≤10 个汉字），发送失败回退纯文本；欢迎语、搜索回复、报错文案仍是 `text`（2048 字节上限，按 1900 字节截断，裸 URL 由微信识别）。**不发语言标签**：用户关心的是「这项目能干什么」，技术栈对扫读没有价值，空间留给功能短句。
>
> 另有一个后台开关会毁掉整条微信通道：若「我的企业 → 微信插件 / 微工作台」里开启了**「在微工作台中始终进入主页」**，微信端只会收到被截断到 20 字节的 text、其余消息类型被转成一句「请在企微中查看」。**必须确认它是关闭的**，否则无论发什么类型用户都读不到内容。上面的实测里 textcard / news 都能正常显示，说明该开关当前是关闭状态；换环境部署时要重新确认。
同时：企微后台「接收消息」无报错记录，Vercel Logs 能看到对应的 POST `/api/wecom-callback`（text 先回加密回执、异步处理；event 回 200 空串、异步送礼包）。
若保存回调 URL 时报验证失败 → 核对 Token / EncodingAESKey / corpid 三者与 Vercel env 是否逐字一致，并确认该 env 已随部署生效。

配置正确后，用户侧在个人微信里的样子（无需安装企业微信）：

![个人微信里的聊天示意：欢迎语、每日简报、自然语言提问](assets/wecom-chat.svg)

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

简报触发与抓取已拆成两个工作流（避免双触发）：

- Actions →「每日热榜管线」→ Run workflow（`workflow_dispatch`）：抓取 / 补全两步全绿，随后「兜底触发一次简报推送」返回 200（三重门控保证与小时触发不重复）。
- Actions →「简报小时触发」→ Run workflow：触发步骤 curl 返回 200 + `{"sent":…,"skipped":…,"failed":…}`，且 `failed` 为 0（`skipped` 可以是未到推送时间/当日已发的正常跳过）。
- 若人为把某步弄挂，且配置了 `WECOM_ADMIN_USERID`，管理员应收到企微告警文本（含 Run URL），且对应工作流日志里告警步骤 `errcode == 0` 断言通过。

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

## 7. 端到端联调清单（八项全过即视为交付）

### ① 手动跑通每日管线：数据入库 + 简报送达微信

- **操作**：先 Actions →「每日热榜管线」→ Run workflow（`workflow_dispatch`）完成抓取 / 补全；再 Actions →「简报小时触发」→ Run workflow 手动触发一次简报。
- **预期观察**：
  1. 「每日热榜管线」抓取 / 补全两步全绿；「简报小时触发」的触发步骤 curl 返回 `{"sent":N,"skipped":M,"failed":0}`（`failed` 必须为 0；`skipped` 是未到推送时间 / 当日已发 / 未满间隔的正常跳过）。
  2. Neon：`select count(*) from trending_entries where date = current_date;` 大于 0（20 个榜单：总榜 + `SCRAPER_LANGUAGES` 的 19 个语言榜）；`repos.topics` 有非空数组（enrich 生效）。
  3. 微信：`active = true` 的订阅者收到**每日简报 news 卡片**（最多 8 篇；仅首篇 OG 大图、其余不发图；标题为 `🔥/🆕 序号. owner/repo ★星标 (+增量)｜≤10 字短简介`，🔥 按增长率（+增量/总星标 ≥5%）给最快的 1–2 条；条数按「条数 N」设置、默认 8；不存在半句简介——短句由模型单独生成，拿不到就省略。news 发送失败时自动回退原纯文本简报，不会重复发送）。
  4. Vercel Logs：手动触发的 `/api/cron-push-digest` 一次 200 记录。

### ② 自然语言搜索 → 纯文本列表

- **操作**：微信里发「**本周 rust 的 ai 项目**」。
- **预期观察**：
  1. 收到**纯文本**回复：每行形如 `1. owner/repo ★1234 (+567)（新上榜） — 中文简介 https://github.com/owner/repo`，末行固定提示 `💡 「收藏 3」收藏第 3 条；「不感兴趣 3」只针对它；发「帮助」看全部指令`；链接是裸 URL，微信里可点进 GitHub。
  2. Neon：`search_caches` 该用户行的 `results` 数组被覆盖写（`select results from search_caches where wecom_userid = '<测试用户>';`），序号与回复列表一一对应——这是下一步「收藏 1」的前提。
  3. 换一句「**找一下本周比较火的Java项目**」：同样有结果（中文描述 → 语言 java + 周榜，不因关键词误判返回空）；「**本周 swift 项目**」也能命中（语言过滤走 `repos.language`，不再只看语言榜）。

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
  4. 「**收藏一**」（中文数字）与「收藏 1」等价，同样成功；无 `search_caches` 行（既没搜索也没收到简报）→ 回复 `还没有可收藏的结果，先搜索，或等今天的简报（简报里的项目也能收藏）`；有缓存但序号越界 → 回复 `最近一次结果只有 M 条，没有第 N 条`；两种情况都不写库。
  5. 收到每日简报后直接「收藏 N」也可用（简报推送同样写 `search_caches`，序号与简报行一一对应）。

### ⑤ 「我的收藏」/「取消收藏 1」→ star 消失

「我的收藏」**以 GitHub star 为准**，本地 `favorites` 表只是缓存与兜底。

- **操作**：发「**我的收藏**」→ 按列表序号发「**取消收藏 1**」。
- **预期观察**：
  1. 已绑定：回 `你的 star：` + 最近 10 个 `N. owner/repo https://github.com/owner/repo`，末行 `还有 N 个 · 在 GitHub 看全部 https://github.com/<login>?tab=stars`；一个 star 都没有才回空态文案 `你还没有收藏任何项目。…`。网页端手工 star 的仓库也会出现在这里（这就是本次改造的目的）。
  2. 未绑定：回本地收藏列表 + 末行 `绑定 GitHub 后这里会显示你全部 star`。
  3. 拉取失败（429/500/网络）：回本地收藏列表 + `暂时读不到 GitHub star，下面是本服务里收藏过的项目`；**绝不**谎报"没有收藏"。token 失效（401）→ `授权已过期，请重新发'绑定'`。
  4. 「取消收藏 1」按**同一份 GitHub 列表**（star 时间倒序）解析序号，回 `已取消收藏 <owner/repo>`；序号超出已展示的 10 条但 star 更多 → `只列出了最近 10 个 star，第 N 个请到 GitHub 取消：…`（不谎称没有）。
  5. GitHub：该仓库 star **消失**；Neon：对应 `favorites` 行被删除（未在本地留过记录的 star 本无行可删，属正常）。
  6. 只读接口用公开端点 `GET /users/<login>/starred`（`sort=created&direction=desc&per_page=10`，另发一次 `per_page=1` 从 `Link: rel="last"` 读总数）。**不需要 `user` 权限**，已绑定用户无需重新授权；代价是只看得见公开仓库的 star。

### ⑥ 降级路径：LLM 挂掉 / 无效查询

- **操作 A（LLM 不可用）**：把 Vercel `LLM_API_KEY` 临时改错（或 LLM 服务不可达）→ 再发一次搜索「本周 rust 的 ai 项目」；再手动 dispatch 一次管线看简报。
- **预期 A 观察**：
  1. 搜索**仍返回纯文本列表**——`parseSearchQuery` 走 `fallbackParse` 正则回退（语言别名、`本周/今天/本月` 时间词、关键词仍被提取），不是报错。
  2. 简报**仍列出仓库**（中文简介降级为 description 截断或整段省略——只少破折号后那段，仓库列表永远存在）。
  3. 修复 key 后回复恢复带 LLM 增强的解析结果。
- **操作 B（无效/乱写查询）**：发一条无有效条件的文本（如「啊啊啊乱写一通」）。
- **预期 B 观察**：解析/检索兜底链给出中文回复——空结果时为 `没找到符合条件的项目，试试换个说法…`，解析或发送异常时为 `抱歉，处理你的查询时出了点问题，请稍后再试。`；**任何输入都有中文回复，绝无静默**（回调端点已先回 200，处理在异步进行，回复可能有数秒延迟）。

### ⑦ 简报条数 / 推送时间 / 推送间隔

- **操作**：依次发「**条数 3**」「**推送时间 20:30**」「**每 2 天推送**」。
- **预期观察**：
  1. 三条回执分别为 `✅ 每日简报条数已设为 3（1–8）`、`✅ 简报推送时间已设为 20:30（北京时间）`、`✅ 简报推送间隔已设为每 2 天（1–30，未到间隔不重复推送）`。
  2. Neon：`select preferences from subscribers where wecom_userid = '<测试用户>';` 三个字段同时存在（后续「订阅 …」不会把它们刷掉）。
  3. 次日 20:30 后收到 3 条简报；间隔 2 天时次日不推、第三天推（默认 09:00 由 **Vercel Cron** `vercel.json` 的 `0 1 * * *` 触发，其余时间由 `.github/workflows/digest-hourly.yml` 每小时**第 17 分**兜底；门控在 `pushDigests` 内）。
  4. 越界输入（「条数 0」「推送时间 25:99」「每 99 天」）→ 回用法提示，不写库。

### ⑧ 加入即自动收到简报（第二账号）

- **操作**：用一个**新**企微成员账号把应用加入可见范围，然后从工作台点开该应用（触发 `enter_agent`），或直接发一条任意文本。
- **预期观察**：
  1. 先收到 3 行欢迎语，紧接一条今日简报（仓库可点、每行一句中文简介）。
  2. Neon：该用户 `subscribers` 有新行（`active = true`，`preferences` 为空偏好），`last_digest_at` = **北京当日 00:00**（回填零点而非当前时刻，保证次日仍按 09:00 正常推送，不会把推送时间永久后移）。
  3. `search_caches` 有该用户的简报条目 → 紧接着发「收藏 1」可用（需先「绑定」）。
  4. 再次进入应用 / 再发消息**不重复**送礼包；当天 09:17 那次 tick 也不会再推一份（`last_digest_at` 已记当日）。

---

## 8. 部署后验证要点（SDD 台账累积项）

1. **Neon 双跑幂等冒烟**：本地对同一日期跑两次抓取 CLI（`npx tsx src/scraper/run-scraper.ts`）→ 第二次 `trending_entries` 行数**不增加**（唯一约束 `trending_entries_date_period_language_full_name_unique` 兜底；这是台账移交本任务的必做项）。
2. **官方企微加密样例活体验证**：crypto 实现已按官方 QDG6eK 样例向量在单测钉死；后台保存回调配置时 **GET URL 验证必须成功**——活体通过即证明 Token / EncodingAESKey / corpid 三元组与 Vercel env 配置接线一致（单测过 ≠ 配置对）。
3. **live `workflow_dispatch` 全链路跑一次**：即第 7 节 ①，抓取 / 补全 + 简报触发全绿，简报真实送达微信，才算管线闭环。
4. **`WECOM_AGENT_ID` 必须存纯数字字符串**：`daily.yml` 告警 payload 用 `jq … tonumber`；Vercel 端代码也做 `Number(env.WECOM_AGENT_ID)`——两侧都要求纯数字（如 `1000001`），存带引号/字母的值会把失败告警本身打挂。
5. **Vercel Node runtime ≥ 22**：`package.json` engines 地板 + AI SDK v7 依赖硬要求；部署日志确认 22.x，别在项目设置里回退到 20。
6. **真库验证 distinct-on 去重**：选一个同时出现在总榜（`language='all'`）与语言榜的仓库，搜该语言 → 结果里该 `owner/repo` **只出现一次**（单测只能钉 SQL 形状与 JS 安全网，真库执行属本任务验证）。
7. **`search_caches` 写入非原子**：当前为 delete + insert 两次 `await`（已记账未改）。如并发搜索时偶发丢缓存（「收藏 N」读到旧列表），改用 `db.batch` 一轮原子提交；MVP 可接受，先知悉即可。
8. **`subscribers.display_name` 以空串占位**：schema 为 `NOT NULL` 无默认值，onboarding 插入 `''`（企微回调只带 userid，暂无名称来源，且无任何运行时读取方）。可选后续迁移改为可空，不阻塞 MVP。
9. **本地跑 CLI 报 `fetch failed`（TLS 拦截环境）**：部分企业网络/安全软件会对 HTTPS 做中间人拦截——curl 能通（用 Windows 证书库）但 Node fetch 报 `unable to verify the first certificate`。本地执行时加 `NODE_OPTIONS="--use-system-ca"` 即可（如 `NODE_OPTIONS="--use-system-ca" npx tsx src/scraper/run-scraper.ts`）；GitHub Actions 托管 runner 无此问题，管线不受影响。
10. **Vercel 函数对 `src/` 的相对导入必须带 `.js` 扩展名**（如 `from '../src/config.js'`）：Vercel 构建用项目本地 TypeScript 逐文件转译、不做打包，产物按原样保留在函数包里由 Node ESM 运行时直接加载；Node ESM 不做无扩展名解析，漏写 `.js` 会导致**全部**端点 `FUNCTION_INVOCATION_FAILED`（平台通用 500，运行时日志里是 `ERR_MODULE_NOT_FOUND`）。`package.json` 必须保留 `"type": "module"`（缺了它 ESM 语法的产物会被当 CJS 解析，同样全站 500）。vitest/tsx 均支持 `.js → .ts` 映射，本地不受影响，所以**只有线上会炸**——新增相对导入时务必带上 `.js`。
11. **企微回调 POST 的 `content-type` 是 `text/xml`，Vercel 不解析 → `req.body === undefined`**：`@vercel/node` 的 `getBodyParser` 只认 `application/json`（→对象）、`application/x-www-form-urlencoded`（→对象）、`application/octet-stream`（→Buffer）、`text/plain`（→字符串），**其余一律返回 `undefined`**（源码 `packages/node/src/serverless-functions/helpers.ts`）。body 为 undefined 时旧代码得空串 → 提取不到 `Encrypt` → 验签 401（线上表现：用户发消息无回复、`subscribers` 无行；单测全都喂字符串，测不出这层只在运行时 body 解析处出现的坑）。`api/wecom-callback.ts` 的处理：body 非 string/Buffer 时，从 `req.on('data'/'end')` 读回 `addHelpers/restoreBody` 回放到流上的**原始字节**（本项目是普通函数 listener，`serverless-handler.mts` 必走 `addHelpers`，回放一定就位），5 秒超时兜底。**新增回调类端点时永远不要假设 `req.body` 是字符串**——用联调探针（合法签名 POST）做一次线上验证，别拿用户消息当测试。

---

## 9. 邮箱备用通道（Resend）与落地页

邮箱是**备用入口**：给「不想加入企业」或「企微名额已满」的人，每天固定时间收同一份简报（不截断、可转发），但不能对话/收藏。主线仍是第 3 步的企微成员 + 微信插件。

### 9.1 域名与 DNS（一次性，需你操作）

1. 买一个便宜域名即可（`.top` / `.xyz` 年费几十元）；**仅用于发信，不需要 ICP 备案**。DNS 托管在 Cloudflare（免费）或注册商处都行。
2. Resend 控制台 → Domains → Add Domain，建议用子域发信（如 `mail.example.com`）。
3. 按控制台给出的记录逐条加 DNS：**SPF**（TXT）、**DKIM**（TXT/CNAME）、**DMARC**（TXT，建议 `v=DMARC1; p=none; rua=mailto:...`）。
4. 等 Resend 显示 **Verified**；设 Vercel env：
   - `RESEND_API_KEY`（Resend → API Keys）
   - `EMAIL_FROM=GitHub 热榜 <digest@mail.example.com>`
   - `PUBLIC_BASE_URL=https://<生产域名>`（邮件里的确认/设置/退订链接用；不配会回退请求 Host）
5. 免费额度 3,000 封/月、100 封/天，本项目远低于上限（单轮 ≤50 封 + **全局**每天确认信上限 50 封，同一地址 10 分钟冷却，不是「每人每天 50 封」）。

### 9.2 落地页与成员名额

- 入口：`https://<domain>/api/join`（分享这个链接即可）。
- 页面顺序：**先企微、后邮箱**；邮箱按钮始终首屏可见。企微卡永远带一行兜底：「如果加入时提示名额已满或无法加入，可直接用邮箱订阅。」
- 名额判断：`isWeComAccepting()` 优先级 = 显式 `WECOM_ACCEPTING` > 成员数探测（`count < WECOM_MEMBER_LIMIT`，默认 100）> `true`。探测走 `user/simplelist`（需通讯录读取权限），失败回退手动开关；结果缓存在 `kv_cache` 1 小时，`cron-push-digest` 每小时顺带刷新。
- **企业认证是扩容的唯一正解**：未认证企业成员名额约 100；认证（个体工商户可办，约 300 元/年）后按后台上限把 `WECOM_MEMBER_LIMIT` 调大，或直接设 `WECOM_ACCEPTING=true` 关闭门控。认证是后台操作，代码不依赖。
- 二维码：仓库内自带 `docs/assets/wecom-join-qr.png`（加入企业）与 `docs/assets/wecom-plugin-qr.png`（微信插件），落地页默认直接引用，无需配置。换邀请码时重新导出并用 `WECOM_JOIN_QR_URL` / `WECOM_PLUGIN_QR_URL` 覆盖即可（值可以是任意可公开访问的地址）。
  - 两张码都是 `qrcode` 生成的标准码（660×660、白底、4 模块静区），用 jsQR 与 ZXing 双解码器验证过内容——**不要直接用企微后台导出的邀请卡片截图**：卡片是深色底，二维码周围没有白色静区，多数扫码器和解码库会检测不到。
  - 当前内容：加入企业 = `https://work.weixin.qq.com/join/4ssGfdH0aTh2w7OiYbGk2A/...`；微信插件 = `http://weixin.qq.com/q/02GyC9Zsxv9ad1O0gChGcF`。
  - 两张码并排且外观相同，页面用图注（「加入企业」/「微信插件」）区分，缺哪张就只渲染哪张，并在第一步改写成文字指引——不会出现「让你扫码但下面空白」。
- 企微成员可见范围要覆盖新加入的成员（应用可见范围 + 微信插件侧）；否则用户加入后发「你好」收不到回复。

落地页两种状态的排版（名额未满时企微在前并标「推荐」，邮箱入口始终首屏可见；名额满时邮箱升为推荐）：

![落地页示意：企微卡在前并标推荐，邮箱入口始终可见](assets/join-page.svg)

### 9.3 验证清单

1. 打开 `/api/join`：企微在前、带「推荐」、邮箱按钮可见、兜底文案存在；设 `WECOM_ACCEPTING=false` 后邮箱升为推荐、企微显示「名额已满」。
2. 落地页提交邮箱 → 收到确认邮件 → 点链接：确认成功页 + **立即收到今日简报**（品牌头、概览、条目卡片、中文简介、页脚设置/退订链接）。
3. 邮件条数设 20 → 20 条全部展示、无「已截断」；同日企微仍按 1900 字节截断。
4. 设置 17:00 + 每 2 天 → 当日 17:00 收到、次日不收到、第三日收到；18:00 后不再发信。
5. 关注方向（如 Python + AI）→ 邮件只出相关项目；概览仍正常。
6. 点邮件页脚「退订」→ 成功页；再次点同链接仍 200（幂等）；Gmail「一键退订」走 RFC 8058 POST 同样生效。
7. 邮件详情里 SPF / DKIM / DMARC 均为 pass；QQ 邮箱 / Gmail / 163 均不进垃圾箱。
8. `email_subscribers` 里的订阅者**不出现**在 `subscribers` 表（邮箱用户不进入企微成员链路）。
9. 未配置 `RESEND_API_KEY` / `EMAIL_FROM` 时：落地页邮箱卡显示「即将开放」，cron 静默跳过邮件，企微链路不受影响。

邮件到达后的版面（品牌头、当日概览、条目卡片、页脚设置/退订链接）：

![邮箱简报示意：品牌头、今日概览、条目卡片与退订链接](assets/email-digest.svg)

### 9.4 频率与护栏（代码内置，无需配置）

- 发送窗口 **09:00–18:00（北京时间）**；窗口外 cron 直接跳过。
- 每人在窗口内选整点时间（09:00–17:00）与间隔（每天 / 每 2 / 3 / 7 天）；当天只发一封；条件 UPDATE 抢占防并发重发。
- 单轮 ≤50 封、间隔 ≥250ms；全局日上限 300 封；确认信同地址 10 分钟冷却、全局每日 50 封。
- 连续失败 5 次自动停用该订阅者；失败回滚 `last_sent_at` 并累计计数。
- 每封带 `List-Unsubscribe` + `List-Unsubscribe-Post`（RFC 8058），正文含可见退订链接；无外链图片、无追踪像素。

---

## 10. 行为说明：每日概览 / 意图边界 / 自备模型 Key

### 10.1 每日简报开头的「今日概览」

简报（企微与邮件）在标题之后、条目之前会有一段 2–3 句中文概览，概括当天这批项目的共同方向，由运营方 LLM 在**构建当日快照时生成一次**并写入 `kv_cache` 的 `digest-snapshot:<日期>`（字段 `abstract`，≤120 字）。之后所有推送（含新用户礼包）都读快照，**不再调用模型**。

- 概览生成失败 / LLM 挂掉 → 只是少这一段，简报照常发（绝不因为概览失败而不发）。
- 当天榜单为空 → 不调用模型，也不编造概览。
- 想确认某天的概览：`select value from kv_cache where key = 'digest-snapshot:' || current_date;` 看 `abstract` 字段。

### 10.2 意图边界：无关问题不再回热榜

`src/agent/intent.ts` 先做一遍**零成本规则判定**（`你是谁`/`你能做什么` → `about`；`今天天气`/`股票`/`讲个笑话` 等 → `off_topic`），命中就直接回对应引导文案；规则判不准才交给 LLM 判定 `intent` 字段。`about` / `off_topic` 分支**不查库、不写 `search_caches`**——所以「收藏 N」仍指向最后一次真实列表。

原则是**只拦明显无关的**：`看看热榜`、`今天有什么`、`本周 rust 的 ai 项目` 全部照常返回列表；规则漏判只会退化成老行为（回列表），不会误伤正常提问。

### 10.3 自备模型 Key（互动烧用户自己的额度）

归属划分：

| 路径 | 用谁的 Key |
|---|---|
| 每日快照（中文简介 + 今日概览） | 运营方（Vercel `LLM_*`），每天约 1 次 |
| 每日推送 / 新用户礼包 | 不调模型（读快照） |
| **互动：解析搜索意图、生成搜索结果简介** | **用户自己的 Key**；没配 → 规则解析 + 只读 `repo-zh` 共享缓存，一分钱不花 |

命令：

- 「**设置模型**」→ 回一次性链接 `https://<域名>/api/set-key?t=…`（15 分钟有效、只能提交一次）。
- 「**我的模型**」→ 未配置时明说互动会退回规则模式；已配置时回 `地址 / 模型 / sk-…后四位`。
- 「**清除模型**」→ 三列一起置空。

表单端点 `api/set-key.ts` 的护栏：token 验签 + `jti` 一次性（`kv_cache['setkey-used:<jti>']`）；接口地址必须 `https://`；**保存前用用户自己的 Key 发一次 10 秒超时的最小 ping**，失败原样回表单不落库；Key 只以 AES-256-GCM 密文入 `subscribers.llm_key_enc`，错误文案与 `llm:last-error` 一律 `sk-***` 脱敏，页面回显只给掩码。

**风险与取舍**：不配置的用户，互动仍可用但只有英文原描述（共享缓存命中时是中文）。这正符合「互动不烧运营方额度」的要求；要提升体验就配 Key。`TOKEN_ENCRYPT_KEY` 缺失时「设置模型」直接回「服务未配置加密密钥」，不生成链接。

### 10.4 运行日志：每次调用走了哪条路 + 规则层怎么长大

**一次调用 = 一条 trace**（`src/obs/trace.ts`，写 `agent_runs` 正式表；写表失败或迁移未执行时降级到 `kv_cache`，7 天 TTL。主表目前没有自动清理）。一条入站消息的「路由 → 规则意图 → 模型选择 → 解析来源 → 检索条数 → 简介命中 → 发送字节」按顺序记在 `steps` 里，每步带距上一步的 `ms`，一眼看出慢在哪一段。每日推送同理（`kind=push`，每个真正发送的订阅者一条）。

打开（手机浏览器也能看，服务端渲染，无需登录）：

```
https://ghtrending.cyou/api/trace?secret=<CRON_SECRET>&n=50
https://ghtrending.cyou/api/trace?secret=<CRON_SECRET>&u=<wecom_userid>   # 只看某个人
```

- `n` 默认 50、上限 200；`u` 按 userid 过滤。
- 鉴权复用 `CRON_SECRET`（`?secret=` 或 `Authorization: Bearer`），错了一律 401。
- 时间一律北京时间；`✓`/`✗` 表示整条调用成不成功（`✗` 展开能看到脱敏后的错误）。
- 原话截断 80 字；`sk-` 开头的 Key 一律打成 `sk-***`，**密钥不进 trace**。

**为什么不用 Vercel Function Logs**：要登录控制台、只留几天、没有请求 id——同一条消息的六七步是互不关联的散行，多用户并发时根本串不起来。

**规则层的语料来源（匿名意图日志）**：`src/agent/intent-log.ts` 只记三类「规则层没学到」的输入——模型判成 `about`/`off_topic` 的长句、搜出来 0 条的查询、≤10 字的短句。正常搜索不记；样本里**没有 userid**，只有原话（≤60 字）与最终意图，key 按天分桶（同日同句一行），120 天过期。

攒几天后跑这条，排前面的就是下一批该写进 `ABOUT_PATTERNS` / `OFF_TOPIC_TOPICS`（`src/agent/intent.ts`）的说法：

```sql
select value->>'text' as text, value->>'final' as final, count(*) as days
from kv_cache
where key like 'intent-miss:%' and expires_at > now()
group by 1, 2 order by 3 desc limit 20;
```

规则层每长大一点，就少一次模型调用、少一次误判——而且互动的模型调用本来就烧用户自己的 Key，运营方在这条链路上不产生开销。

### 10.5 推送去重与口味

每日简报不再「有什么推什么」，而是先过三道门再选条：

| 门 | 规则 | 代码 |
|---|---|---|
| 7 天去重 | 最近 7 天推过的仓库不再出现（`pushed:<userid>`，记 60 条、60 天过期） | `src/agent/push-history.ts` |
| 增长门槛 | 老面孔 7 天内至少涨 `GROWTH_MIN_DELTA = 100` 星；新上榜的（`isNew`）不看增量 | `src/agent/digest-filter.ts` |
| 口味 | 已收藏的不推（用户已经知道了）；被「不感兴趣」压到 −2 的语言整门丢掉；收藏集中的语言/话题靠前 | `src/agent/taste.ts` |

**没东西就静默**：全部被过滤掉时不发「今日暂无」，也不写 `search_caches`（「收藏 N」仍指向上一份真实列表），不回滚 claim（当天不再每小时重试）。距上次发消息满 3 天补一句「最近没有明显增长的新项目」；有屏蔽语言时点名原因（`（已按你的「不感兴趣」屏蔽 go）`），避免用户把沉默读成「坏了」。首日礼包也记推送历史，否则第二天会把礼包里的仓库再推一遍。

**口味只有两个来源**，都可在库里直接看到，没有隐式推断：

- 收藏（`favorites` join `repos`）：同一语言收藏 ≥2 个才算偏好，最多 +3；单个收藏是偶然，不参与排序。
- 显式反馈（`taste:<userid>`）：看完简报回「感兴趣」/「不感兴趣」，作用于刚收到的那批。一次反馈最多影响该批的**前 2 门语言、前 3 个话题**；只看最近 10 次事件；语言权重 clamp ±3，累计 ≤ −2 才真正屏蔽；再连说两次「感兴趣」即可恢复。

三条自查 SQL：

```sql
-- 最近给谁推了什么（7 天去重窗口的依据）；lastSentAt 用来算「静默了几天」
select key, value->>'lastSentAt' as last_sent,
       jsonb_array_length(value->'items') as n
from kv_cache where key like 'pushed:%' and expires_at > now() order by 2 desc nulls last;

-- 口味反馈（含被屏蔽的方向）
select key, value->'events' from kv_cache where key like 'taste:%' and expires_at > now();

-- 收藏画像：谁的收藏集中在哪些语言
select f.wecom_userid, r.language, count(*) as n
from favorites f join repos r on r.full_name = f.full_name
where r.language is not null group by 1, 2 order by 3 desc limit 20;
```

**调阈值的依据，不是给用户加开关**：看 `/api/trace` 里 `kind=push` 的 `digest-empty` 占比。高于约 20% 说明门槛太严（用户会觉得简报「时有时无」），把 `src/agent/digest-filter.ts` 的 `GROWTH_MIN_DELTA` 从 100 往下调；显著低于 5% 说明门槛太松，可以往上调。一次只动这一个常量。

trace 上对应的步骤：`signals`（收藏/屏蔽数量）、`dedup-before` / `dedup-after`（过滤前后各剩多少）、`digest-empty` 与 `quiet`（为什么没发）。

**两条已知限制，不是 bug**（详见第 5 步 ⑤）：

- 「我的收藏」走公开端点 `/users/<login>/starred`，只看得到**公开仓库**的 star；私有 star 需要 `user` scope，会让所有已绑定用户重新授权，不做。
- 只列最近 10 条 + 总数 + 「在 GitHub 看全部」链接，不是全部列举。

---

## 附：观察指标落地准备

- `search_caches`（每用户覆盖写）天然记录**检索行为**；
- `favorites`（含 `starred_on_github` 同步状态）天然记录**收藏行为**。

MVP 复盘直接查库即可，无需另埋点。
