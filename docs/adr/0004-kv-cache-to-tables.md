# ADR 0004：kv_cache 只放短命键值，运行日志进正式表

**状态**：已采纳（迁移 0004）

## 背景

早期为了「零迁移」上线，运行日志（trace）与工具调用流水塞进了 `kv_cache`，用 `trace:<ISO>-<id8>` 当 key、7 天 TTL 当清理。消息量上来后问题暴露：

- 看板要按天聚合、按 kind 统计、算 p50/p95——都要把 JSON 全捞出来在内存里算，kv 表没有索引可用；
- 用户过滤靠 `value->>'userid'`，无法建索引；
- 与 `tool_calls.run_id` 的关联只能是字符串约定；
- 「迁移 0002 的 journal `when` 设在未来」还让后续迁移被静默跳过，进一步固化了这个临时方案。

## 决策

- 新增 `agent_runs`（`id / kind / userid / text / ok / total_ms / input_tokens / output_tokens / steps`）与 `tool_calls`（`run_id / tool / args_hash / status / latency_ms`），带时间、类型、用户三个索引。
- trace 主路径写 `agent_runs`；写失败或表不存在时**仍退回 kv_cache**（7 天 TTL），`/api/trace` 合并两个数据源——迁移前写入的记录不会凭空消失。
- `tool_calls` 不设外键：工具调用发生在 `agent_runs` 落库之前，外键会把正常请求卡死。
- 修正 journal：`0002`/`0003` 的 `when` 归一化到过去；`0004` 的 `when` 暂取 `1793200000002`（大于生产账本现有最大值），否则会被静默跳过。
- **绝不手改生产 `drizzle.__drizzle_migrations`**：只改仓库里的 journal，再正常 `npm run db:migrate`。

## 后果

- 看板查询走索引，`/api/metrics` 不需要把整表读进内存。
- 迁移未执行时系统不崩（trace 走 kv、metrics 回 503 并提示迁移），但看板不可用。
- 多了一个需要清理的表：`agent_runs` / `tool_calls` 目前没有自动清理任务，靠后续加 TTL 任务或分区解决；量级是每条消息一行，短期可接受。
