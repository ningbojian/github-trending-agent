# GitHub Trending Agent for WeCom

🇨🇳 [中文](README.md) · 🇺🇸 [English](README.en.md)

A conversational GitHub Trending search agent built as a WeCom self-built app: GitHub Actions scrapes the daily trending list and enriches topics via the official GitHub API; users can search in natural language, favorite and unfavorite repos in chat, and sync stars to their GitHub account.

- **Daily trending scrape and enrichment**: `.github/workflows/daily.yml` triggers `src/scraper/trending.ts` at 01:00 UTC every day to scrape the Trending page; `src/github/enrich.ts` enriches topics via the official GitHub API before storage
- **Dual interaction modes and query-parse cache**: scheduled top-10 digests (falls back to template-only if the LLM fails; the repo list is always delivered); natural-language queries (e.g. “rust AI projects this week”) are parsed by `src/agent/parse-query.ts` for multi-dimensional filtering; `src/agent/query-cache.ts` caches parsed queries for 30 days with a `parse:v1:` versioned key, so repeated queries skip the model, while expired entries, bad values, or DB read failures are treated as cache misses
- **OAuth favorite sync and recent-result cache**: after GitHub OAuth via `src/github/oauth.ts` (scope `public_repo` only), users can “favorite N / unfavorite N” in chat, sync stars automatically, and list “my favorites”; `src/agent/recent-results.ts` extracts the latest search-result cache shared by “favorite N” and `interested/not interested` feedback, distinguishing “no search yet” from “search returned empty”
- **Complete WeCom integration and two delivery channels**: `src/wecom/crypto.ts` handles callback encryption and decryption, `src/wecom/router.ts` routes commands (search, favorite, bind, subscription preferences, unsubscribe, help), and `src/wecom/onboarding.ts` enables subscription on the first message; users can enable the WeCom plugin in personal WeChat to receive daily digests and chat directly without installing the WeCom app; the `/api/join` landing page provides a WeCom join guide plus an email fallback (Resend, double opt-in, no truncation, unsubscribe)
- **Data and engineering**: Drizzle ORM + SQL migrations (`drizzle/`) manage users, subscriptions, search results, and favorites; Vitest tests under `tests/` cover parsing, search, callbacks, crypto, query cache, recent results, and other core logic

Deployment and integration steps: [docs/deploy.md](docs/deploy.md).

---

## Architecture

![Data flow: scheduled scrape → storage → hourly snapshot (one model round) → WeCom and email channels](docs/assets/flow.svg)

In one sentence: **scraping and translation happen once, and both channels share the same daily snapshot**—WeCom truncates at 3800 bytes, email does not; personalization only selects different rows in memory by preference and does not call the model again.

## Usage (WeCom)

**What it is**: GitHub Actions scrapes GitHub Trending daily and enriches topics; in WeCom you can receive daily digests passively and search the trending list in natural language; after authorizing GitHub, you can favorite repos in chat and sync stars to your account, and list or remove favorites.

Send to the app in WeCom (or the WeCom plugin in WeChat):

- **Natural-language search**: “rust AI projects this week” → numbered list with a hint to favorite by index
- **Favorite N / Unfavorite N**: “Favorite N” favorites by index from the latest search list; “Unfavorite N” removes by index from “My Favorites”; both sync GitHub stars (bind first)
- **My Favorites**: list favorited repos with indexes
- **Bind**: reply with a GitHub authorization link (scope `public_repo` only); complete authorization in the browser to bind
- **Subscription preferences**: e.g. “subscribe python,ai” sets daily digest keywords
- **Unsubscribe**: stop daily digests (GitHub binding and favorites are unaffected; send “subscribe python,ai” again to resume)
- **Help**: show usage

**Daily digest**: GitHub Actions scrapes at 01:00 UTC (09:00 Beijing time); `digest-hourly.yml` calls `api/cron-push-digest` hourly and sends each subscriber a digest at their push time (default 09:00) and interval (default daily); if the LLM fails, it falls back to template-only and the repo list is always delivered. Sending the first message to the app automatically enables the subscription.

What users see (all in personal WeChat, no WeCom app needed):

![Chat in personal WeChat: welcome message, daily digest, natural-language question](docs/assets/wecom-chat.svg)

## Two delivery channels

- **WeCom member + WeChat plugin (main path)**: users scan the “join enterprise” code to become a member, enable the WeCom plugin in WeChat, and send “hello” to enable subscription; afterwards they receive digests in personal WeChat and can reply to chat. No WeCom app installation required. Unverified enterprises have about 100 member slots; after verification (sole proprietorships can apply), capacity follows the console limit; slot gating uses `WECOM_ACCEPTING` / `WECOM_MEMBER_LIMIT`.
- **Email (fallback)**: the email entry on the `/api/join` landing page → double opt-in → receives the same digest at a fixed time daily (**no truncation**, forwardable, unsubscribe/change frequency). Suitable for people who do not want to join the enterprise or when slots are full; digest only, no chat.
- Thresholds and DNS configuration (Resend + custom domain, no ICP filing required) are in [docs/deploy.md](docs/deploy.md) section 9.

The landing page puts **WeCom first and email second**; the email entry is always visible above the fold; when WeCom slots are full, email becomes “recommended” and the WeCom card keeps fallback copy:

![Landing page: WeCom card first and recommended, email entry always visible](docs/assets/join-page.svg)

Email digest layout (brand header, daily overview, item cards, footer settings/unsubscribe links):

![Email digest: brand header, daily overview, item cards, unsubscribe links](docs/assets/email-digest.svg)

## Configuration: GitHub token and LLM

### Two kinds of GitHub tokens

| Purpose | Provided by | Where configured | Notes |
| --- | --- | --- | --- |
| **Server-side topic enrichment** (`src/github/enrich.ts`) | Repo owner / ops | `GITHUB_TOKEN` in Vercel + Actions (**optional**) | Only affects GitHub API rate limits; works without it, and Actions falls back to the token injected by GitHub |
| **End-user favorite star sync** | Users themselves, **no manual token** | No env var: user sends “bind” → browser OAuth (scope `public_repo` only) | Token is encrypted with AES-256-GCM derived from `sha256(TOKEN_ENCRYPT_KEY)` and stored in `subscribers.github_token_enc`; only used for favorite/unfavorite GitHub calls |

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
- `opencode` uses an [OpenCode Console](https://opencode.ai/console/login) key: leave `LLM_BASE_URL` empty for the Go subscription ($10/month); set it to `https://opencode.ai/inference/openai/v1` for pay-as-you-go. This gateway only offers chat/completions, and the code uses the `.chat()` entry.
- Model keys are **server-side unified configuration** (one key serves all users); there is no “bring your own LLM key” because that would require storing and encrypting user keys with low benefit and high risk.
- Only structured output and short text generation are used: a cheaper model is sufficient; `REPO_SUMMARY_MODE=off` disables summary generation entirely (zero LLM cost; summaries fall back to truncated English descriptions).
- After switching, check Vercel logs for `[llm] provider=… model=… input_tokens=… output_tokens=…`; any LLM failure only degrades gracefully (search falls back to regex parsing, summaries omitted).

**Deployment and integration**: see [docs/deploy.md](docs/deploy.md).