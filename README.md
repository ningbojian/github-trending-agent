<!-- profile-agent:readme:start -->
基于企业微信自建应用实现对话式 GitHub Trending 检索 Agent：GitHub Actions 每日抓取热榜并调用 GitHub 官方 API 补全 topics 标签，聊天窗口内支持自然语言检索、收藏与取消收藏（同步 star 到 GitHub 账号）。

- **每日热榜抓取与补全**：`.github/workflows/daily.yml` 每天 UTC 01:00 触发 `src/scraper/trending.ts` 抓取 Trending 页面，`src/github/enrich.ts` 调用 GitHub 官方 API 补全 topics 标签后入库
- **双模式交互**：被动定时推送 top10 简报（LLM 故障时降级为纯模板，仓库列表始终送达）；主动发送自然语言（如「本周 rust 的 ai 项目」）由 `src/agent/parse-query.ts` 解析查询条件进行多维度过滤
- **OAuth 收藏同步**：`src/github/oauth.ts` 完成 GitHub 授权（scope 仅 public_repo）后，可在聊天中「收藏 N / 取消收藏 N」，自动同步 star 到用户账号，并支持「我的收藏」列表
- **企业微信接入完整**：`src/wecom/crypto.ts` 实现回调加解密，`src/wecom/router.ts` 分发指令（搜索、收藏、绑定、订阅偏好、退订、帮助），`src/wecom/onboarding.ts` 首条消息自动开通订阅
- **数据与工程化**：Drizzle ORM + SQL 迁移（`drizzle/`）管理用户、订阅、搜索结果与收藏数据；`tests/` 覆盖解析、检索、回调、加解密等核心逻辑的 Vitest 用例

部署与联调步骤见 [docs/deploy.md](docs/deploy.md)。
<!-- profile-agent:readme:end -->
基于企业微信自建应用实现对话式GitHub Trending检索Agent。GitHub Actions每日抓取热榜，调用GitHub官方API补全topics标签。支持两种交互模式：被动定时推送简报；用户使用自然语言主动检索，由LangGraph解析查询条件进行多维度过滤。用户授权后可以在聊天窗口直接收藏仓库，自动同步Star到GitHub账号；支持查看、取消收藏. 

---

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

**每日简报**：GitHub Actions 每天 UTC 01:00（北京时间 09:00）抓取热榜，向 `active` 订阅成员推送 top10 简报；LLM 故障时降级为纯模板，仓库列表始终送达。给应用发首条消息即自动开通订阅。

**部署与联调**：见 [docs/deploy.md](docs/deploy.md)。