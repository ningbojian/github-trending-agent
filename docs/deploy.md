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
   - 实际命令是 `drizzle-kit migrate`（见 `package.json` scripts），迁移 SQL 为 `drizzle/0000_silly_shatterstar.sql` 与 `drizzle/0001_living_the_leader.sql`（后者新增 `subscribers.last_digest_at`，供简报推送时间/间隔门控使用）。
   - `drizzle.config.ts` 直接读 `process.env.NEON_DATABASE_URL`；若当前 shell 没有该变量，先 `set -a; source .env; set +a` 再跑，或内联：
     `NEON_DATABASE_URL='postgresql://…' npm run db:migrate`。

**验证**

在 Neon SQL Editor（或任意 psql）执行：

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by 1;
```

应出现 7 张业务表：`repos`、`trending_entries`、`subscribers`、`favorites`、`search_caches`、`kv_cache`、`email_subscribers`（另有 drizzle 迁移记录表）。
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
| `LLM_PROVIDER` | 必填 | LLM：`anthropic` \| `openai` \| `deepseek` \| `ali` \| `mimo` \| `zhipu` \| `moonshot` \| `doubao` \| `siliconflow` \| `openrouter` \| `gemini` \| `ollama` \| `custom`（常见厂商的内置 endpoint 见下表；不区分大小写，前后空格会被裁掉） |
| `LLM_API_KEY` | 必填 | LLM：提供商 API Key（`ollama` 本地部署可填任意非空串） |
| `LLM_MODEL` | 必填 | LLM：模型 ID（如 `claude-sonnet-4-5`、`glm-4.6`、`kimi-k2-0905-preview`、`doubao-seed-1-6`） |
| `LLM_BASE_URL` | **可选** | LLM：覆盖或自定义 OpenAI 兼容 endpoint（如 `https://your-proxy.example.com/v1`）。`LLM_PROVIDER=custom` 时**必填**；其他提供商填了就覆盖内置 endpoint |
| `REPO_SUMMARY_MODE` | **可选** | 仓库中文简介：缺省/`llm` = 批量调 LLM 生成并全局缓存（`kv_cache` key `repo-zh:<fullName>`，180 天）；设 `off` = 完全不调 LLM，一律用英文 description 截断 40 字符（零 token 开销） |
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
| `RESEND_API_KEY` | **可选** | 邮箱备用通道：Resend API Key（第 9 步）；不配则邮箱入口显示「即将开放」、cron 跳过邮件 |
| `EMAIL_FROM` | **可选** | 邮箱：发件人，须为 Resend 已验证域名下的地址，如 `GitHub 热榜 <digest@mail.example.com>` |
| `PUBLIC_BASE_URL` | **可选** | 邮箱/落地页：站点根地址（无尾斜杠），用于邮件里的确认/设置/退订链接；缺省回退请求 Host |
| `WECOM_JOIN_QR_URL` | **可选** | 落地页：「加入企业」二维码图片地址；不配则显示文字指引 |
| `WECOM_PLUGIN_QR_URL` | **可选** | 落地页：「微信插件」二维码图片地址；不配则显示文字指引 |
| `WECOM_APP_NAME` | **可选** | 落地页：应用显示名（缺省 `GitHub 热榜`） |
| `WECOM_ACCEPTING` | **可选** | 落地页名额门控：`true`/`false` 显式覆盖，优先于成员数探测 |
| `WECOM_MEMBER_LIMIT` | **可选** | 名额上限（默认 `100`；企业认证后按后台上限调整） |

**LLM 提供商对照表**（除 `anthropic` / `mimo` 外均走 OpenAI 兼容协议；任一 `LLM_BASE_URL` 都可覆盖）：

| `LLM_PROVIDER` | 内置 endpoint | 常见 `LLM_MODEL` 示例 |
| --- | --- | --- |
| `anthropic` | Anthropic 官方 | `claude-sonnet-4-5` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `deepseek` | DeepSeek 官方 | `deepseek-chat` |
| `ali` | 阿里云百炼（`@ai-sdk/alibaba`） | `qwen-plus` |
| `mimo` | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-flash` |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
| `moonshot` | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| `doubao` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6`（或推理接入点 ID） |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-32B` |
| `openrouter` | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| `ollama` | `http://localhost:11434/v1`（本地/自托管） | `qwen3:8b` |
| `custom` | 由 `LLM_BASE_URL` 指定（必填） | 任何 OpenAI 兼容网关 |

> 只用到结构化输出（`generateObject`）与短文本生成：换成便宜模型即可，`REPO_SUMMARY_MODE=off` 更能把简介成本降到零。模型是否支持 JSON 输出由厂商决定，首次切换后看 Vercel 日志里是否出现 `[llm] provider=… model=…`（有输出即调用成功）。

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

> `VERCEL_URL` 作为 Actions secret 时**只填域名**（`myapp.vercel.app`），不带 `https://` 前缀、不带尾斜杠——`digest-hourly.yml` 会拼成 `https://${VERCEL_URL}/api/cron-push-digest`（`daily.yml` 只负责抓取/补全，不再触发简报）。

---

## 3. 企业微信管理后台：自建应用与回调

**步骤**（管理后台 <https://admin.work.weixin.qq.com>）

1. 「我的企业 → 企业信息」记录**企业 ID**（corpid）→ 存入 Vercel `WECOM_CORP_ID`。
2. 「应用管理 → 自建 → 创建应用」：填名称、logo、可见范围（先覆盖测试成员）。创建后记录 **AgentId** 与 **Secret** → 分别存入 `WECOM_AGENT_ID`（纯数字字符串）、`WECOM_SECRET`。
   - **logo 直接用** [docs/assets/icon-750.png](assets/icon-750.png)（750×750 PNG，原创图标，可商用）。
3. 应用详情 →「接收消息 → 接收消息服务器配置 → 设置 API 接收」：
   - **URL**：`https://<domain>/api/wecom-callback`
   - **Token**：自定义随机串 → 与 Vercel `WECOM_CALLBACK_TOKEN` **完全一致**
   - **EncodingAESKey**：自定义（43 位）→ 与 Vercel `WECOM_CALLBACK_AES_KEY` **完全一致**
   - 保存时企微会向该 URL 发起 GET URL 验证；**保存成功即验证通过**（这是 crypto 配置三元组的活体验证，见第 8 节要点 2）。
4. 「我的企业 → 微信插件」：**开启「允许成员使用微信插件」**，并把目标成员加入**可见范围**（应用可见范围 + 微信插件侧）。用户在微信中通过「企业微信插件」入口绑定企业后，即可在微信里收发该应用的消息——搜索回复、每日简报都从这里送达。

**应用图标**

- 上传 [assets/icon-750.png](assets/icon-750.png)（750×750 PNG）；源文件是 [assets/icon.svg](assets/icon.svg)。需要别的尺寸时，临时 `npm i -D @resvg/resvg-js` 用同一份 SVG 重新导出即可（PNG 只用于上传后台，应用运行时不依赖该包）。
- 微信插件会话、聊天列表会把它当头像显示（圆形或圆角方形裁切）：图形主体都落在中心安全区内，裁切不会缺角，24px 下仍能认出。
- 「我的企业 → 企业信息」的企业 logo 也可以用同一张图，保持入口一致。
- 原创几何图形（深底 + 绿色对话气泡 + 白色上升折线），不含第三方商标/字体/图库素材，可商用；落地页与 favicon 用的是同一造型的内联副本。

**验证**

用成员账号**首次进入应用**（企微工作台点开该应用，触发 `enter_agent` 事件）或给应用发一条首条文本（如「你好」）→ 先收到欢迎语（3 行：`你好！我是 GitHub 热榜助手，已为你自动开通每日简报（默认每天 09:00 北京时间推送）。…`），紧接一条**今日简报**（markdown，每行 `N. [owner/repo](链接) ★星标 (+增量) — 中文简介`）。
再次进入应用 / 再发消息**不会**重复送礼包（订阅者行已存在）。
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

- Actions →「每日热榜管线」→ Run workflow（`workflow_dispatch`）：抓取 / 补全两步全绿（该工作流不再触发简报）。
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
  3. 微信：`active = true` 的订阅者收到**每日简报**（企微 markdown，每行 `N. [owner/repo](https://github.com/owner/repo) ★1234 (+567)（新上榜） — 中文简介`，条数按「条数 N」设置、默认 10；仓库名可点，简介是 ≤28 字中文概括。LLM 挂掉或 `REPO_SUMMARY_MODE=off` 时只省略破折号后的简介，仓库列表永远在）。
  4. Vercel Logs：手动触发的 `/api/cron-push-digest` 一次 200 记录。

### ② 自然语言搜索 → markdown 列表

- **操作**：微信里发「**本周 rust 的 ai 项目**」。
- **预期观察**：
  1. 收到企微 **markdown** 回复：每行形如 `1. [owner/repo](https://github.com/owner/repo) ★1234 (+567)（新上榜） — 中文简介`，末行固定提示 `💡 直接回复「收藏 N」收藏任意一条；发「帮助」查看全部指令`；仓库名可点进 GitHub。
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

- **操作**：发「**我的收藏**」→ 按列表序号发「**取消收藏 1**」。
- **预期观察**：
  1. 「我的收藏」回编号列表（`owner/repo` + 收藏日期）；空列表回 `你还没有收藏任何项目。…`。
  2. 「取消收藏 1」回 `已取消收藏 <owner/repo>`。
  3. GitHub：该仓库 star **消失**。
  4. Neon：对应 `favorites` 行被**删除**（`select count(*) from favorites where full_name = '…';` 为 0）；GitHub 侧未确认成功（如 401）时行不删、回引导文案——属正常降级。

### ⑥ 降级路径：LLM 挂掉 / 无效查询

- **操作 A（LLM 不可用）**：把 Vercel `LLM_API_KEY` 临时改错（或 LLM 服务不可达）→ 再发一次搜索「本周 rust 的 ai 项目」；再手动 dispatch 一次管线看简报。
- **预期 A 观察**：
  1. 搜索**仍返回 markdown 列表**——`parseSearchQuery` 走 `fallbackParse` 正则回退（语言别名、`本周/今天/本月` 时间词、关键词仍被提取），不是报错。
  2. 简报**仍列出仓库**（中文简介降级为 description 截断或整段省略——只少破折号后那段，仓库列表永远存在）。
  3. 修复 key 后回复恢复带 LLM 增强的解析结果。
- **操作 B（无效/乱写查询）**：发一条无有效条件的文本（如「啊啊啊乱写一通」）。
- **预期 B 观察**：解析/检索兜底链给出中文回复——空结果时为 `没找到符合条件的项目，试试换个说法…`，解析或发送异常时为 `抱歉，处理你的查询时出了点问题，请稍后再试。`；**任何输入都有中文回复，绝无静默**（回调端点已先回 200，处理在异步进行，回复可能有数秒延迟）。

### ⑦ 简报条数 / 推送时间 / 推送间隔

- **操作**：依次发「**条数 3**」「**推送时间 20:30**」「**每 2 天推送**」。
- **预期观察**：
  1. 三条回执分别为 `✅ 每日简报条数已设为 3（1–20）`、`✅ 简报推送时间已设为 20:30（北京时间）`、`✅ 简报推送间隔已设为每 2 天（1–30，未到间隔不重复推送）`。
  2. Neon：`select preferences from subscribers where wecom_userid = '<测试用户>';` 三个字段同时存在（后续「订阅 …」不会把它们刷掉）。
  3. 次日 20:30 后收到 3 条简报；间隔 2 天时次日不推、第三天推（整点 tick 由 `.github/workflows/digest-hourly.yml` 每小时触发，门控在 `pushDigests` 内）。
  4. 越界输入（「条数 0」「推送时间 25:99」「每 99 天」）→ 回用法提示，不写库。

### ⑧ 加入即自动收到简报（第二账号）

- **操作**：用一个**新**企微成员账号把应用加入可见范围，然后从工作台点开该应用（触发 `enter_agent`），或直接发一条任意文本。
- **预期观察**：
  1. 先收到 3 行欢迎语，紧接一条今日简报（仓库可点、每行一句中文简介）。
  2. Neon：该用户 `subscribers` 有新行（`active = true`，`preferences` 为空偏好），`last_digest_at` = **北京当日 00:00**（回填零点而非当前时刻，保证次日仍按 09:00 正常推送，不会把推送时间永久后移）。
  3. `search_caches` 有该用户的简报条目 → 紧接着发「收藏 1」可用（需先「绑定」）。
  4. 再次进入应用 / 再发消息**不重复**送礼包；当天 09:00 的整点 tick 也不会再推一份（`last_digest_at` 已记当日）。

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
5. 免费额度 3,000 封/月、100 封/天，本项目远低于上限（单轮 ≤50 封 + 每人每天确认信 ≤50 封）。

### 9.2 落地页与成员名额

- 入口：`https://<domain>/api/join`（分享这个链接即可）。
- 页面顺序：**先企微、后邮箱**；邮箱按钮始终首屏可见。企微卡永远带一行兜底：「如果加入时提示名额已满或无法加入，可直接用邮箱订阅。」
- 名额判断：`isWeComAccepting()` 优先级 = 显式 `WECOM_ACCEPTING` > 成员数探测（`count < WECOM_MEMBER_LIMIT`，默认 100）> `true`。探测走 `user/simplelist`（需通讯录读取权限），失败回退手动开关；结果缓存在 `kv_cache` 1 小时，`cron-push-digest` 每小时顺带刷新。
- **企业认证是扩容的唯一正解**：未认证企业成员名额约 100；认证（个体工商户可办，约 300 元/年）后按后台上限把 `WECOM_MEMBER_LIMIT` 调大，或直接设 `WECOM_ACCEPTING=true` 关闭门控。认证是后台操作，代码不依赖。
- 二维码：把「我的企业 → 加入企业」与「微信插件」两个二维码图片传到任意可公开访问的地址，填 `WECOM_JOIN_QR_URL` / `WECOM_PLUGIN_QR_URL`；不配则落地页显示文字指引。
- 企微成员可见范围要覆盖新加入的成员（应用可见范围 + 微信插件侧）；否则用户加入后发「你好」收不到回复。

落地页两种状态的排版（名额未满时企微在前并标「推荐」，邮箱入口始终首屏可见；名额满时邮箱升为推荐）：

![落地页示意：企微卡在前并标推荐，邮箱入口始终可见](assets/join-page.svg)

### 9.3 验证清单

1. 打开 `/api/join`：企微在前、带「推荐」、邮箱按钮可见、兜底文案存在；设 `WECOM_ACCEPTING=false` 后邮箱升为推荐、企微显示「名额已满」。
2. 落地页提交邮箱 → 收到确认邮件 → 点链接：确认成功页 + **立即收到今日简报**（品牌头、概览、条目卡片、中文简介、页脚设置/退订链接）。
3. 邮件条数设 20 → 20 条全部展示、无「已截断」；同日企微仍按 3800 字节截断。
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

## 附：观察指标落地准备

- `search_caches`（每用户覆盖写）天然记录**检索行为**；
- `favorites`（含 `starred_on_github` 同步状态）天然记录**收藏行为**。

MVP 复盘直接查库即可，无需另埋点。
