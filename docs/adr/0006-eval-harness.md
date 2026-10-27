# ADR 0006：金标评测集与回归门禁

**状态**：已采纳

## 背景

「你怎么知道它好？」在这个项目里最初没有答案：规则路由与提示词改完只能靠手发几条消息看结果，改坏了也不会有人发现。工具层引入后风险更高——模型可能选错工具、传错参数，而这些错误在人工抽查里很难稳定复现。

## 决策

- `evals/golden/*.jsonl` 存金标样本：路由、解析、工具选择三层，一条一行，字段省略即不计分；加载时报 `file:line`，ID 唯一，禁止出现 userid。
- 适配器**复用生产代码**（`decideTextRoute`、`classifyByRules` + `parseSearchQuery` 的零依赖路径、fixture + `formatSearchReply`），不复制一份「评测专用实现」。
- 确定性指标：路由准确率、macro-F1、规则覆盖率/误判率、解析 exact match、groundedness（回复里的 `owner/repo` 必须出现在 fixture 中）、运行时错误数。
- 阈值全部写死在 `evals/thresholds.ts`：路由/工具/groundedness = 1.0、解析 ≥ 0.95、回归 0；`npm run eval` 任一不过退出码非 0，CI 直接红。
- baseline 入库，只有手动 `--update-baseline` 才能改；评测报告打印每条错误的 id / 输入 / expected / actual。
- 评测自身也有测试（schema、指标、适配器、runner），并保证同一输入跑两次结果一致。

## 后果

- 改规则/提示词有了可回放的门禁：故意改坏一条规则，CI 会红。
- 金标集需要持续维护；当前覆盖的是高频命令与对抗样例，长尾自然语言仍靠线上匿名样本补充。
- 模型质量评分（`--llm --repeat 3`）只作为本地参考，不进 CI——它不稳定，也不该让流水线依赖外部模型可用性。
