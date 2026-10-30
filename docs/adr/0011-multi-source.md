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

## 后续评估（2026-10-29）

上线首日（仅 2026-10-29 一天数据）对 HN / Lobsters 做了噪音评估：

| 指标 | HN | Lobsters |
| --- | --- | --- |
| 当日条数 | 24 | 29 |
| 链接指向 GitHub | 2（1 个 gist、1 个 markdown 仓库） | 1（一个普通仓库） |
| 与当日 Trending top20 重合 | 0 | 0 |
| 明显非开发内容 | 约 7/24（体育、健康、鸟类、硬件…） | 基本没有 |
| 结构化标签 | 无 | 有（security / rust / release…） |

结论：**暂不把 HN / Lobsters 放进简报或观察**。它们是文章/讨论源，不是仓库源；接进仓库卡片要新增内容形态，且与 Trending 几乎不重合。继续每日入库（边际成本为零），攒满 14 天后再看三个阈值：

- 每天 ≥5 条指向 GitHub 仓库；
- 与 Trending 的重合 ≥10%；
- HN / Lobsters 互相重复率可接受（同一天已出现多条同题）。

未达标前只考虑作为面板里的「社区热议」小栏目，不进微信推送。若将来接入，优先 Lobsters（标签结构化、开发者向），并作为已有仓库的「社区热议」信号，而不是独立条目。

## 后果

- 多源抓取不增加 Vercel 函数数，也不影响每日推送预算。
- Hugging Face 在部分网络环境不可达（本机实测连接超时），只能在 Actions runner 上跑；本地跑时该源报错、其他源照常。
- GitHub Search 有独立限流（认证 30 次/分钟；未认证 10 次/分钟），每天只发一次查询。
- 跨源观察的数量与质量需要观察一段时间；HN/Lobsters 按上文阈值在 14 天后复评，暂不进观察或简报。
- 迁移 0006 已应用：账本 7 条，`source_items` 13 列。
