# 评测集与回归门禁

> 回答一个问题：**凭什么说这版比上版好？**
> 答案不是「我觉得」，而是一组可复跑的金标用例、一组确定性指标、一条会变红的 CI。

## 1. 设计边界

- **CI 只跑确定性指标**：不调模型、不读数据库、不碰网络、不需要任何 secret。
  `npm run eval:ci` 在干净 checkout 上即可复现同一个数字。
- **模型评分不进 CI**：答案「好不好」需要评分模型，成本和波动都不该卡合并。
  `--llm` 入口已预留，等评分器落地后只在本地跑。
- **适配器复用生产代码**：路由直接调 `decideTextRoute`，解析按 `handleSearch` 的真实顺序
  先 `classifyByRules` 再 `parseSearchQuery(..., { kind: 'none' })`，排版调 `formatSearchReply`。
  评测里跑的必须是线上跑的那份逻辑，否则测了个寂寞。

## 2. 目录

```
evals/
  schema.ts               # Zod 契约：字段省略 = 不计分；禁止 userid 等标识
  load.ts                 # JSONL 逐行加载；报 file:line；ID 全局唯一
  adapters/{route,parse,answer,tools}.ts
  metrics.ts              # 纯函数指标（无 I/O）
  thresholds.ts           # CI 门禁阈值
  report.ts               # 人读报告 + 基线比较（方向感知）
  run.ts                  # 编排；不调 process.exit
  cli.ts                  # 退出码：0 通过 / 1 阈值或回归 / 2 评测自身出错
  seed-from-intent-log.ts # 从匿名 intent-miss 日志捞待标注候选
  golden/*.jsonl          # 金标用例
  fixtures/search/*.json  # groundedness 用的结果集
  baselines/deterministic.json
```

## 3. 怎么跑

```bash
npm run eval            # 跑金标 + 对比基线（日常）
npm run eval:ci         # CI 入口（同上；无 secrets）
npm run eval:baseline   # 手动更新基线（必须在确认指标变化是预期之后）
npm run eval:seed       # 打印待人工标注的真实用户说法（只读日志）
```

调试时加 `--json` 输出完整结果；报告里每条失败都会打印 `id / 输入 / 期望 / 实际 / notes`。

## 4. 指标与阈值

| 指标 | 含义 | 门禁 |
| --- | --- | --- |
| `route_accuracy` | 指令路由命中率 | = 1 |
| `route_macro_f1` | 各类路由的宏平均 F1（防止只背高频类） | 报告用 |
| `rule_coverage` | 意图规则层敢下结论的比例 | 报告用 |
| `rule_false_positive_rate` | 规则下了结论但结论与金标相悖 | = 0 |
| `parse_exact_match` | 写出的槽位全部命中的比例 | ≥ 0.95 |
| `parse_field_<field>` | 逐字段准确率（分母只算写了该字段的用例） | 报告用 |
| `fallback_parse_coverage` | 规则拿不准、最终走 fallbackParse 的比例 | 报告用 |
| `tool_route_exact` | 工具路由命中（route 对；写了 tool 的用例工具名也对） | = 1 |
| `tool_arg_accuracy` | 工具参数命中（分母只算写了 `args.repo` 的用例） | = 1 |
| `groundedness` | 回复里每个仓库都来自结果集、点名项都出现 | = 1 |
| `runtime_errors` | 用例执行抛异常的次数 | = 0 |

**为什么路由必须是 1.0**：路由错了，用户会收到一句完全无关的话（把「收藏一下」当搜索词发出去）。
**为什么解析只要求 0.95**：`fallbackParse` 是启发式，不是契约；但它也不能明显退化。

## 5. 金标写法

一行一个 JSON 对象：

```json
{"id":"route-push-time-search-trap","text":"每天 star 最多的项目","notes":"锚定整句：带后缀的句子必须落搜索","expected":{"route":{"kind":"handler","name":"search"}}}
```

- `id` 小写字母/数字/连字符，全局唯一（跨文件也算）。
- `expected` 至少要写一层（route / parse / answer / tools）；**没写的层不计分**。
- 解析用例只写「应该对」的字段。已知分词残渣（如「增长最」）不写进金标——
  否则评测会阻止未来修好它。这类已知问题写在 `notes` 里。
- 对抗样例必须写 `notes`，说明它防的是什么。

## 6. 基线纪律

- 基线文件入库，`--update-baseline` **只能手动跑**，且必须把 diff 一起提交。
- 比较是方向感知的：错误率类指标（`rule_false_positive_rate`、`runtime_errors`）下降才算改善。
- 允许的回归条数是 0：指标只能变好或不变。

## 7. 提示词与缓存的纪律

`parseSearchQuery` 的缓存键前缀是 `parse:v1:`，TTL 30 天。**改动 `buildPrompt` 必须同时把
`parse:v1` 改成 `parse:v2`**，否则线上会继续命中旧提示词产出的缓存结果，而评测走
`{ kind: 'none' }` 绕过缓存，根本看不见这个偏差。

同理，任何改变解析语义的改动，都应该先补一条金标，再改实现。

## 8. CI

`.github/workflows/eval.yml`：push / PR 触发，`npm ci && npm run eval:ci`。
故意改坏一条路由规则 → `route_accuracy` 下降 → 退出码 1 → 红灯。

## 9. 当前覆盖与下一步

- 路由：每个 handler 至少一条，外加错字 / 尾标点 / 动词粘连等对抗样例。
- 解析：意图（about / off_topic / 漏判）与六个槽位的主力问法。
- 答案：fixture 排版 + groundedness。
- 工具：`tools.jsonl` 覆盖「深挖 / 健康度 / 改订阅」与反例（普通搜索、`前 5 个`、
  「类似的项目」），适配器直接调生产 `routeToTools`。正例写 `expected.args.repo`
  才能计入参数准确率；反例只写 `route: "search"`，确保「不该进工具的别进」。
  「走对路、带错仓库」由 `tool_arg_accuracy` 单独暴露，不会混进路由分。
- 下一步：扩大解析金标到 150–200 条；`--llm` 评分器落地后只本地跑。
