# ADR 0010：薄 H5 控制面板，不是第二个每日入口

**状态**：已采纳（2026-10-29）

## 背景

企微机器人适合「推送 + 快捷指令」，不适合展示和编辑状态：跟踪列表、历史简报、收藏、订阅设置用聊天命令做都很别扭。用户想要一个 H5，但明确担心「用户要花时间点进去再熟悉一遍，谁会每天看」。

结论：H5 只做**聊天里做不了的事**，入口由机器人按需发链接，不追求日活。每日习惯仍留在微信里。

## 决策

- **一个 Serverless Function** `api/panel.ts`，`?view=` 路由（overview / tracking / history / favorites / memory / settings），服务端渲染 HTML，复用 `src/http/html.ts`；不引入前端框架。样式集中在 `src/panel/styles.ts`，经 `renderPage` 的 `styles` 选项注入 `<style>`，不再散落内联 style。加上它正好 12 个函数（Hobby 上限，`tests/vercel-config.test.ts` 兜底）。
- **鉴权用签名链接**：token = `base64url(payload).HMAC(payload)`，payload 含 userid、过期时间（7 天）与链接版本号；密钥从 `TOKEN_ENCRYPT_KEY` 派生。重置链接 = 版本 +1（`panel-version:v1:<userid>`），旧链接立即 401。不引入 WeCom OAuth（后续可加）。
- **入口**：命令「我的面板」发链接；后续在跟踪变化摘要末尾按需附带。**不**每天推面板。
- **写操作**只接受 POST + 签名 token；所有动态文本经 `escapeHtml`。设置复用 `mergePreferences` 与 `normalizePreferences`，校验口径与聊天命令一致（HH:MM、1–8 条、1–30 天）。暂停/恢复推送同样走 `mergePreferences({ active })`。
- **跟踪管理**复用 `tracking-service`（命令与面板同一套读写）；每用户 10 个上限不变。
- **收藏**复用 `stars` 的 `favoriteRepo` / `unfavoriteRepo`：面板按仓库名直接收藏/取消，聊天按「收藏 N」解析序号，最终都走「先落本地行 → GitHub star → 回填同步状态」。未绑定 GitHub 时与聊天一致，只提示先「绑定」。
- **记忆**复用 `profile` 的 `rememberFact` / `forgetFacts` / `forgetAll`；面板按条删除（传完整原文作为关键词），清空需显式点「清空全部」。
- **模型入口**是设置页里的一次性链接（`signSetKeyToken`，15 分钟、只能提交一次），不把 Key 放进面板链接本身。
- **历史简报**读 `archive:v1:<date>`（Phase 1 起每天写，30 天 TTL）；面板展示最近 14 天。
- **收藏与搜索**：收藏列表 + 简单的仓库名/描述搜索（直接查 `repos`）；搜索结果的「收藏」按钮走与聊天相同的写路径。
- **视觉**：所有网页（面板、join、set-key、订阅、邮箱设置、metrics、trace、OAuth）统一深墨夜景 + 无色玻璃卡片；色板在 `BRAND.dark`，共享层是 `src/ui/styles.ts`，面板只在 `src/panel/styles.ts` 保留导航、hero 与更紧的间距增量。邮件模板仍是浅色（邮件客户端不支持毛玻璃）。机器人只是 hero 侧边的小角落，不占独立大卡。
- **今日机器人**：总览 hero 侧边一颗服务端渲染的 SVG 软球 + 两颗环绕贴纸。日贴纸按北京星期（周一帽、周二耳机、周三围巾、周四灯泡、周五外套、周六墨镜、周日咖啡），天气球按 Open-Meteo（IP 默认、城市可改；3 小时缓存 + 10 分钟失败负缓存；失败时显示云）。贴纸素材是 Twemoji 官方 SVG（CC-BY 4.0，静态文件在 `/docs/assets/emoji/`）。
- **唯一的客户端 JS**：机器人的捏合形变与贴纸环绕/拖拽是一段内联脚本（无 WebGL、无外部依赖）。这是「服务端渲染、不引前端框架」的例外；没有脚本时静态机器人和贴纸仍然可见。
- 隐私：天气只按 IP 到城市级，不存精确坐标；手动选择的城市存在 `preferences.weatherCity`。链接可被转发，因此只放用户自己的低敏数据、7 天过期、可重置；不记 IP/访问日志。模型入口会签发一次性 token，持有面板链接的人也能为本人重置模型配置——这是「链接即身份」的已知代价，后续上 WeCom 网页授权可收敛。

## 后果

- 面板是低频工具：有需要才点开；打开率不作为成功指标，验证两周后再决定是否扩展。
- 写操作与聊天命令共用服务层，但输入方式不同：面板按 fullName 直接操作，聊天按序号。两条入口的文案各自维护，数据规则只有一份。
- 没有 OAuth：拿到链接的人能看到并修改该用户的数据（低敏 + 模型配置）。后续若要更强身份，再上 WeCom 网页授权。
- 函数数到 12，之后新增端点必须先合并或删除一个。
- 搜索是简化版（ILIKE），不是聊天里的自然语言检索；深度搜索仍回微信。
