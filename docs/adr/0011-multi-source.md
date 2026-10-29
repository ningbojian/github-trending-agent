# ADR 0011：多源内容——四个适配器都入库，观察先只吃结构化信号

**状态**：已采纳（2026-10-29）

## 背景

产品原来只有 GitHub Trending 一个来源，观察与简报都受限于它。用户希望扩展：Hugging Face、GitHub topic/star 暴涨、HN/Lobsters。计划里的约束是：

- Hobby 套餐 12 个函数已满，**不能新增端点**；
- 抓取应放在 GitHub Actions（有网络、有 GITHUB_TOKEN），不要放进 Vercel 函数；
- 观察质量优先：跨源条目噪音大时，宁可先不入观察。

## 决策

- 新增 `source_items`（migration 0006）：`(source, source_id, captured_date)` 唯一，只存公开数据，不含 userid；`metrics jsonb` 存 stars/downloads/likes/points/comments。
- **四个适配器全部实现并入库**（`src/sources/`）：
  - `hf_models` / `hf_spaces`：Hub API `sort=trendingScore`；
  - `github_search`：近 7 天创建、stars>100 的新仓库（Search API，带 GITHUB_TOKEN）；
  - `hackernews`：Algolia front_page；
  - `lobsters`：`hottest.json`。
- `run-sources.ts` 逐源隔离：单个源失败不拖垮其他源；全部源失败或总条数为 0 才退出 1。daily.yml 加一步、`continue-on-error: true`。
- **观察先只吃 `hf_models/hf_spaces/github_search`**：只取「首次收录 + 该源已有 ≥2 天历史」的条目，与 Trending 重名（fullName）去重，每条带 `[GitHub 新仓库] / [HF 模型]` 标签；每天最多 1 条跨源观察。HN/Lobsters 先入库积累，观察层暂不读取，等评估噪音后再开。
- 简报（news 卡片）仍然只发 GitHub 仓库，不因多源改变卡片形态。

## 后果

- 多源抓取不增加 Vercel 函数数，也不影响每日推送预算。
- Hugging Face 在部分网络环境不可达（本机实测连接超时），只能在 Actions runner 上跑；本地跑时该源报错、其他源照常。
- GitHub Search 有独立限流（认证 30 次/分钟；未认证 10 次/分钟），每天只发一次查询。
- 跨源观察的数量与质量需要观察一段时间；HN/Lobsters 是否进观察，取决于后续评估。
- 迁移 0006 已应用：账本 7 条，`source_items` 13 列。
