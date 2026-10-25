<!-- profile-agent:readme:start -->
基于企业微信自建应用实现对话式 GitHub Trending 检索 Agent：GitHub Actions 每日抓取热榜并调用 GitHub 官方 API 补全 topics 标签，聊天窗口内支持自然语言检索、收藏与取消收藏（同步 star 到 GitHub 账号）。

- **每日热榜抓取与补全**：`.github/workflows/daily.yml` 每天 UTC 01:00 触发 `src/scraper/trending.ts` 抓取 Trending 页面，`src/github/enrich.ts` 调用 GitHub 官方 API 补全 topics 标签后入库
- **双模式交互**：被动定时推送 top10 简报（LLM 故障时降级为纯模板，仓库列表始终送达）；主动发送自然语言（如「本周 rust 的 ai 项目」）由 `src/agent/parse-query.ts` 解析查询条件进行多维度过滤
- **OAuth 收藏同步**：`src/github/oauth.ts` 完成 GitHub 授权（scope 仅 public_repo）后，可在聊天中「收藏 N / 取消收藏 N」，自动同步 star 到用户账号，并支持「我的收藏」列表
- **企业微信接入完整**：`src/wecom/crypto.ts` 实现回调加解密，`src/wecom/router.ts` 分发指令（搜索、收藏、绑定、订阅偏好、退订、帮助），`src/wecom/onboarding.ts` 首条消息自动开通订阅
- **两个触达渠道**：用户在个人微信里启用「企业微信插件」即可每天收简报并直接提问（无需安装企业微信 App）；`/api/join` 落地页提供企微加入引导 + 邮箱备用入口（Resend，双重确认、不截断、可退订）
- **数据与工程化**：Drizzle ORM + SQL 迁移（`drizzle/`）管理用户、订阅、搜索结果与收藏数据；`tests/` 覆盖解析、检索、回调、加解密等核心逻辑的 Vitest 用例

部署与联调步骤见 [docs/deploy.md](docs/deploy.md)。
<!-- profile-agent:readme:end -->

<p align="center">
  <img src="docs/assets/icon.svg" width="88" height="88" alt="GitHub 热榜 · 每日简报">
</p>

基于企业微信自建应用实现对话式GitHub Trending检索Agent。GitHub Actions每日抓取热榜，调用GitHub官方API补全topics标签。支持两种交互模式：被动定时推送简报；用户使用自然语言主动检索，由LangGraph解析查询条件进行多维度过滤。用户授权后可以在聊天窗口直接收藏仓库，自动同步Star到GitHub账号；支持查看、取消收藏. 

---

## 架构一览

![数据流：定时抓取 → 入库 → 每小时快照（一轮模型）→ 企微与邮箱双通道](docs/assets/flow.svg)

一句话：**抓取和翻译只做一次，两个渠道共用同一份当日快照**——企微按 3800 字节截断、邮箱不截断，个性化只是在内存里按偏好挑不同的行，不额外调用模型。

## 使用说明（企业微信）

**这是什么**：GitHub Actions 每日抓取 GitHub Trending 并补全 topics 标签；企业微信里既能被动接收每日简报，也能主动用自然语言检索热榜；用户授权 GitHub 后可直接在聊天中收藏仓库并同步 star 到自己的账号，支持查看与取消收藏。

在企业微信（或微信中的「企业微信插件」）里向应用发送：

- **自然语言搜索**：「本周 rust 的 ai 项目」→ 返回编号列表，末尾提示按序号收藏
- **收藏 N / 取消收藏 N**：「收藏 N」按最近一次搜索列表的序号收藏，「取消收藏 N」按「我的收藏」列表的序号取消，均同步 GitHub star（需先「绑定」）
- **我的收藏**：查看已收藏的编号列表
- **绑定**：回复 GitHub 授权链接（scope 仅 public_repo），浏览器完成授权即绑定
- **订阅偏好**：如「订阅 python,ai」，设置每日简报偏好关键词
- **退订**：停止每日简报（GitHub 绑定与收藏不受影响；再次发「订阅 python,ai」即可恢复）
- **帮助**：查看用法说明

**每日简报**：GitHub Actions 每天 UTC 01:00（北京时间 09:00）抓取热榜；`digest-hourly.yml` 每小时调用 `api/cron-push-digest`，按每位订阅者的推送时间（默认 09:00）与间隔（默认每天）发送简报；LLM 故障时降级为纯模板，仓库列表始终送达。给应用发首条消息即自动开通订阅。

用户侧的实际观感（全程在个人微信里，不需要安装企业微信）：

![个人微信里的聊天示意：欢迎语、每日简报、自然语言提问](docs/assets/wecom-chat.svg)

## 两个触达渠道

- **企微成员 + 微信插件（主线）**：用户扫「加入企业」码成为企业成员，在微信里启用「企业微信插件」后发一句「你好」即自动开通；此后每天在个人微信里收简报，回复即对话。全程不需要安装企业微信 App。未认证企业成员名额约 100，企业认证（个体工商户可办）后按后台上限扩容；名额门控见 `WECOM_ACCEPTING` / `WECOM_MEMBER_LIMIT`。
- **邮箱（备用入口）**：`/api/join` 落地页的邮箱入口 → 双重确认 → 每天固定时间收到同一份简报（**不截断**、可转发、可退订/改频率）。适合不想加入企业或名额已满的人；只收简报，不能对话。
- 门槛与 DNS 配置（Resend + 自有域名，免 ICP 备案）见 [docs/deploy.md](docs/deploy.md) 第 9 节。

落地页的顺序是**先企微、后邮箱**，邮箱入口始终首屏可见；企微名额满时邮箱升为「推荐」，企微卡保留兜底文案：

![落地页示意：企微卡在前并标推荐，邮箱入口始终可见](docs/assets/join-page.svg)

邮箱简报的样子（品牌头、当日概览、条目卡片、页脚设置/退订链接）：

![邮箱简报示意：品牌头、今日概览、条目卡片与退订链接](docs/assets/email-digest.svg)

## 配置：GitHub token 与大模型

### GitHub token 有两种，别混

| 用途 | 谁提供 | 配置在哪 | 说明 |
| --- | --- | --- | --- |
| **服务端补全 topics**（`src/github/enrich.ts`） | 仓库所有者 / 运维 | Vercel + Actions 的 `GITHUB_TOKEN`（**可选**） | 只影响 GitHub API 限额；不配也能跑，Actions 里会退回 GitHub 自动注入的令牌 |
| **终端用户收藏同步 star** | 用户自己，**无需手填 token** | 无环境变量：用户发「绑定」→ 浏览器 OAuth 授权（scope 仅 `public_repo`） | 拿到的 token 用 `sha256(TOKEN_ENCRYPT_KEY)` 派生的 AES-256-GCM 加密后存 `subscribers.github_token_enc`，只用于收藏/取消收藏时调 GitHub |

所以：**用户不需要、也不应该把自己的 token 贴进聊天窗口**——「绑定」走的是标准 OAuth 授权页，权限最小化，随时可在 GitHub 设置里撤销。更换 `TOKEN_ENCRYPT_KEY` 会让已入库密文全部失效，所有人需重新「绑定」（见 [docs/deploy.md](docs/deploy.md) 第 6 节）。

### 大模型：13 个内置提供商 + 任意 OpenAI 兼容网关

只配三个必填项即可：

```bash
LLM_PROVIDER=deepseek        # 见下表
LLM_API_KEY=sk-...           # 提供商的 key
LLM_MODEL=deepseek-chat      # 模型 ID
# LLM_BASE_URL=              # 可选：覆盖内置 endpoint，或接自建/中转网关
```

| `LLM_PROVIDER` | 内置 endpoint | 常见模型示例 |
| --- | --- | --- |
| `anthropic` | Anthropic 官方 | `claude-sonnet-4-5` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `deepseek` | DeepSeek 官方 | `deepseek-chat` |
| `ali` | 阿里云百炼（`@ai-sdk/alibaba`） | `qwen-plus` |
| `mimo` | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-flash` |
| `zhipu` | 智谱 `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
| `moonshot` | Kimi `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| `doubao` | 火山方舟 `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6`（或推理接入点 ID） |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-32B` |
| `openrouter` | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| `ollama` | `http://localhost:11434/v1`（本地/自托管） | `qwen3:8b` |
| `custom` | 由 `LLM_BASE_URL` 指定（**必填**） | 任何 OpenAI 兼容网关 |

- 提供商名不区分大小写、前后空格会被裁掉；填了 `LLM_BASE_URL` 会**覆盖**内置 endpoint（换中转/代理时不用改代码）。
- 模型 key 是**服务端统一配置**（部署方一个 key 服务所有用户），不提供「用户自带大模型 key」：那需要把用户的 key 存入库中并额外加密，收益低、风险高。
- 只用到结构化输出与短文本生成：换便宜模型完全够用；`REPO_SUMMARY_MODE=off` 可完全关闭简介生成（零 LLM 成本，简介退化为英文 description 截断）。
- 切换后看 Vercel 日志里的 `[llm] provider=… model=… input_tokens=… output_tokens=…`，出现即调用成功；LLM 任何失败都只降级不报错（搜索回退正则解析、简介省略）。

**部署与联调**：见 [docs/deploy.md](docs/deploy.md)。