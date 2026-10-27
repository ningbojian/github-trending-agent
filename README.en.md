# GitHub Trending Agent for WeCom

🇨🇳 [中文](README.md) · 🇺🇸 [English](README.en.md)

A conversational GitHub Trending search agent built as a WeCom self-built app: GitHub Actions scrapes the daily trending list and enriches topics via the official GitHub API; users can search in natural language, favorite and unfavorite repos in chat, and sync stars to their GitHub account.

- **Daily trending scrape and enrichment**: `.github/workflows/daily.yml` runs `src/scraper/run-scraper.ts` at 00:30 UTC (08:30 Beijing) every day to scrape the Trending page into the database, then `src/github/run-enrich.ts` fills in topics via the official GitHub API (**store first, enrich after**)
- **Dual interaction modes and query-parse cache**: scheduled top-10 digests (falls back to template-only if the LLM fails; the repo list is always delivered); natural-language queries (e.g. “rust AI projects this week”) are parsed by `src/agent/parse-query.ts` for multi-dimensional filtering; `src/agent/query-cache.ts` caches parsed queries for 30 days with a `parse:v1:` versioned key, so repeated queries skip the model, while expired entries, bad values, or DB read failures are treated as cache misses
- **Rule-first agent loop**: `src/wecom/route-decision.ts` settles commands and `src/agent/intent.ts` rejects off-topic or “about this app” messages, both with zero model calls; only messages like “deep dive owner/repo”, “is this project any good”, or a subscription change enter the AI SDK tool loop (`src/agent/tools.ts`, at most 3 steps), where the model itself picks among trending search, repo detail, code-computed health metrics, and subscription management
- **OAuth favorite sync and recent-result cache**: after GitHub OAuth via `src/github/oauth.ts` (scope `public_repo` only), users can “favorite N / unfavorite N” in chat, sync stars automatically, and list “my favorites”; `src/agent/recent-results.ts` extracts the latest search-result cache shared by “favorite N” and `interested/not interested` feedback, distinguishing “no search yet” from “search returned empty”
- **Long-term memory and weekly review**: “remember …” stores up to 20 facts of 100 characters each (180-day TTL, listed and deleted by command); at most 500 characters are injected into the prompt, and memory only shapes wording — never ranking or whether something gets pushed; a Monday review replays the week's pushes, favorites and feedback and offers to remember the inferred taste
- **Complete WeCom integration and two delivery channels**: `src/wecom/crypto.ts` handles callback encryption and decryption, `src/wecom/router.ts` routes commands (search, favorite, bind, subscription preferences, unsubscribe, help), and `src/wecom/onboarding.ts` enables subscription on the first message; users can enable the WeCom plugin in personal WeChat to receive daily digests and chat directly without installing the WeCom app; the `/api/join` landing page provides a WeCom join guide plus an email fallback (Resend, double opt-in, no truncation, unsubscribe)
- **Data and engineering**: Drizzle ORM + SQL migrations (`drizzle/`) manage users, subscriptions, search results, favorites and run logs; per-request traces and tool-call ledgers land in `agent_runs` / `tool_calls`, and `/api/metrics` reports success rate, p50/p95 latency, routing mix and token usage; `evals/` ships 98 golden cases behind a CI regression gate; Vitest covers parsing, search, callbacks, crypto, query cache and recent results

Deployment and integration steps: [docs/deploy.md](docs/deploy.md).

---

## Architecture

![Data flow: scheduled scrape → storage → hourly snapshot (one model round) → WeCom and email channels](docs/assets/flow.svg)

In one sentence: **scraping and translation happen once, and both channels share the same daily snapshot**—WeCom truncates at 1900 bytes (the text body caps at 2048), email does not; personalization only selects different rows in memory by preference and does not call the model again.

## Usage (WeCom)

**What it is**: GitHub Actions scrapes GitHub Trending daily and enriches topics; in WeCom you can receive daily digests passively and search the trending list in natural language; after authorizing GitHub, you can favorite repos in chat and sync stars to your account, and list or remove favorites.

Send to the app in WeCom (or the WeCom plugin in WeChat). **The router matches Chinese command words**, so send the literal text below — this is a Chinese-first product, and English phrasings fall through to ordinary search:

- **Natural-language search**: `本周 rust 的 ai 项目` (“rust AI projects this week”) → numbered list with a hint to favorite by index; other Chinese questions in the same shape work too
- **Favorite / unfavorite**: `收藏 N` favorites by index from the latest search list; `取消收藏 N` removes by index from “my favorites”; both sync GitHub stars (bind first)
- **My favorites**: `我的收藏`
- **Bind**: `绑定` → replies with a GitHub authorization link (scope `public_repo` only); complete authorization in the browser
- **Feedback**: `感兴趣 3` / `不感兴趣 3` applies to one item by index or by `owner/repo`; two mentions of the same term start suppressing it
- **My subscriptions**: `我的订阅` is a read-only view of keywords, delivery time and interval; `取消订阅 <term>` removes a keyword without touching whether the daily digest is active
- **Subscription preferences**: `订阅 python,ai` sets daily digest keywords; a bare `订阅` asks back for one keyword (answer within 5 minutes)
- **Long-term memory**: `记住 我是做 Agent 开发的` (“remember I build agents”) tunes wording; `我的记忆` lists it, `忘掉 <word>` / `忘掉 全部` deletes it (it never decides whether something is pushed)
- **Model key**: `设置模型` walks you through configuring your own LLM key, `我的模型` shows the current one, `清除模型` deletes it
- **Tool calls**: `深挖 owner/repo` (“deep dive …”) or `这个项目靠不靠谱` (“is this project any good”) lets the model call repo-detail and health tools; ordinary searches stay out of the tool loop — with no key they make zero model calls, and with a key they make exactly one parsing call
- **Unsubscribe**: `退订` stops daily digests (GitHub binding and favorites are unaffected; send `订阅 python,ai` again to resume)
- **Help**: `帮助`

**Weekly review**: after 10:00 every Monday, subscribers who had pushes, favorites or feedback that week get one message — what arrived, what was saved, what to push more or less of next week. When there is a clear taste signal it asks “want me to remember this?”; “yes” writes it to memory, “no” skips. Silent accounts are not messaged.

**Daily digest**: GitHub Actions scrapes at 00:30 UTC (08:30 Beijing); `digest-hourly.yml` calls `api/cron-push-digest` at minute 17 of every hour (not on the hour — GitHub's hourly on-the-hour schedule was observed dropping runs for 17 hours straight), and sends each subscriber a digest at their push time (default 09:00, actually delivered by the 09:17 tick) and interval (default daily); if the LLM fails, it falls back to template-only and the repo list is always delivered. Sending the first message to the app automatically enables the subscription. The whole fan-out runs under a 240-second budget (the function cap is 300 s): past it, no further subscriber is claimed and the rest wait for the next tick. That guarantees “no new claims while about to time out”; it does **not** cover a function hard-killed mid-send — that claim cannot be rolled back, so the subscriber waits one more interval.

What users see (all in personal WeChat, no WeCom app needed):

![Chat in personal WeChat: welcome message, daily digest, natural-language question](docs/assets/wecom-chat.svg)

## Observability and metrics

Two read-only endpoints, both authenticated with `CRON_SECRET` (`?secret=` or `Authorization: Bearer`):

- **`/api/trace`**: which path a message took and where the time went. One call is one row in `agent_runs` (steps, total latency, tokens, success); if the table is missing or the write fails it falls back to `kv_cache` (7-day TTL) and the page merges both sources.
- **`/api/metrics`**: message volume, success rate, p50/p95, routing mix, parse source (rules / cache / model), distinct users (8-character hashes of userid) and tool error rate for the last N days (`?days=7`, max 30). JSON by default; `&format=html` renders a one-page dashboard readable on a phone.

Tool calls get their own `tool_calls` row: tool name, argument hash, status and latency only — arguments can contain the user's own words, and what debugging needs is “how often the same call ran and where it was slow”, not another copy of the content. Neither table is on the business read path; write failures are logged and ignored.

## Evaluation and regression gate

“Why is this version better than the last one?” is not answered by vibes: `evals/golden/` holds 98 golden cases (56 routing, 34 parsing, 7 tool routing, 1 answer), and the adapters **call the production code** (`decideTextRoute`, `classifyByRules` + `parseSearchQuery`, `formatSearchReply`) rather than keeping a second implementation — the eval must run exactly what production runs.

- `npm run eval` computes **deterministic metrics only**: routing accuracy, rule false-positive rate, parse exact match, groundedness (every `owner/repo` in a reply must exist in the result set), tool routing and argument accuracy, runtime errors — then compares against the committed baseline.
- Thresholds live in `evals/thresholds.ts`: routing/tools/groundedness must be 1.0, rule false positives 0, parse ≥0.95, regressions 0; any miss exits non-zero.
- `.github/workflows/eval.yml` runs `npm run eval:ci` on a clean checkout with no secrets, no network, no model calls — **break one rule and CI turns red**.
- Model-judged quality (`--llm`) stays local and out of CI: it is noisy and should not make the pipeline depend on an external model being up.

Details and the “bump `parse:v1` whenever `buildPrompt` changes” rule: [docs/evals.md](docs/evals.md).

## Two delivery channels

- **WeCom member + WeChat plugin (main path)**: users scan the “join enterprise” code to become a member, enable the WeCom plugin in WeChat, and send “hello” to enable subscription; afterwards they receive digests in personal WeChat and can reply to chat. No WeCom app installation required. Unverified enterprises have about 100 member slots; after verification (sole proprietorships can apply), capacity follows the console limit; slot gating uses `WECOM_ACCEPTING` / `WECOM_MEMBER_LIMIT`.
- **Email (fallback)**: the email entry on the `/api/join` landing page → double opt-in → receives the same digest at a fixed time daily (**no truncation**, forwardable, unsubscribe/change frequency). Suitable for people who do not want to join the enterprise or when slots are full; digest only, no chat.
- Thresholds and DNS configuration (Resend + custom domain, no ICP filing required) are in [docs/deploy.md](docs/deploy.md) section 9.

The landing page puts **WeCom first and email second** by default; the email entry is always visible above the fold. When WeCom slots are full (`WECOM_ACCEPTING=false` or the member limit is reached) **the two cards swap places**: email moves first and is marked “recommended”, while the WeCom card keeps its fallback copy:

![Landing page: WeCom card first normally; email card moves first and is marked recommended when slots are full](docs/assets/join-page.svg)

Email digest layout (brand header, daily overview, item cards, footer settings/unsubscribe links):

![Email digest: brand header, daily overview, item cards, unsubscribe links](docs/assets/email-digest.svg)

## Configuration: GitHub token and LLM

### Two kinds of GitHub tokens

| Purpose | Provided by | Where configured | Notes |
| --- | --- | --- | --- |
| **Server-side topic enrichment** (`src/github/enrich.ts`) | Repo owner / ops | `GITHUB_TOKEN` in Vercel + Actions (**optional**) | Only affects GitHub API rate limits; works without it, and Actions falls back to the token injected by GitHub |
| **End-user favorite star sync** | Users themselves, **no manual token** | No env var: user sends “绑定” → browser OAuth (scope `public_repo` only) | Token is encrypted with AES-256-GCM derived from `sha256(TOKEN_ENCRYPT_KEY)` and stored in `subscribers.github_token_enc`; used to read that user's stars (“my favorites”, excluding already-starred repos when pushing) and to favorite/unfavorite, and as the fallback tool-call token when the operator's `GITHUB_TOKEN` is unset |

So: **users do not need to and should not paste their own token into chat**—bind uses the standard OAuth authorization page with least privilege, revocable anytime in GitHub settings. Changing `TOKEN_ENCRYPT_KEY` invalidates all stored ciphertext and everyone must re-bind (see [docs/deploy.md](docs/deploy.md) section 6).

### LLM: 13 built-in providers + any OpenAI-compatible gateway

Only three required settings:

```bash
LLM_PROVIDER=deepseek        # see table below
LLM_API_KEY=sk-...           # provider key
LLM_MODEL=deepseek-chat      # model ID
# LLM_BASE_URL=              # optional: override built-in endpoint or use a self-hosted/proxy gateway
```

| `LLM_PROVIDER` | Built-in endpoint | Common model examples |
| --- | --- | --- |
| `anthropic` | Anthropic official | `claude-sonnet-4-5` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `deepseek` | DeepSeek official | `deepseek-chat` |
| `ali` | Alibaba Cloud Bailian (`@ai-sdk/alibaba`) | `qwen-plus` |
| `mimo` | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-flash` |
| `opencode` | OpenCode Go subscription `https://opencode.ai/inference/go/openai/v1` (chat/completions) | `deepseek-v4.1-flash`, `glm-5.3-flash` |
| `zhipu` | Zhipu `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
| `moonshot` | Kimi `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| `doubao` | Volcengine Ark `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6` (or an inference endpoint ID) |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-32B` |
| `openrouter` | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| `ollama` | `http://localhost:11434/v1` (local/self-hosted) | `qwen3:8b` |
| `custom` | Specified by `LLM_BASE_URL` (**required**) | Any OpenAI-compatible gateway |

- Provider names are case-insensitive and trimmed; setting `LLM_BASE_URL` **overrides** the built-in endpoint (no code change when switching proxies).
- `opencode` uses an [OpenCode Console](https://opencode.ai/console/login) key: leave `LLM_BASE_URL` empty for the Go subscription ($10/month); set it to `https://opencode.ai/inference/openai/v1` for pay-as-you-go. This gateway only offers chat/completions, and the code pins the `.chatModel()` entry.
- **Interactive replies use the user's own key** (configured with “设置模型”, stored AES-256-GCM encrypted): without one the bot does **rule parsing only** — it does not even read the shared parse cache — and makes zero model calls. Daily digests and the daily snapshot still run on the operator's key, so cost does not grow with chat volume.
- Only structured output and short text generation are used: a cheaper model is sufficient; `REPO_SUMMARY_MODE=off` disables only **repo summary** generation (summaries fall back to truncated English descriptions). The daily snapshot still makes one Abstract call, so this is one call per day rather than zero cost.
- After switching, check Vercel logs for `[llm] provider=… model=… input_tokens=… output_tokens=…`. Token usage from interactive replies and the tool loop accumulates into `agent_runs.input_tokens / output_tokens` and is summed by `/api/metrics`; **snapshot model calls run outside the trace context** (once per day), so they are not in those columns — the dashboard's token count covers interactive usage. Any LLM failure only degrades gracefully (search falls back to regex parsing, summaries omitted).

**Deployment and integration**: see [docs/deploy.md](docs/deploy.md).

**Why it is built this way**: [docs/adr/](docs/adr/README.md) records six decisions — the 5-second ack, claim-based pushing, the shared daily snapshot, kv_cache → real tables, rule-first routing, and the eval gate — each stating the constraint and the cost rather than the conclusion alone.