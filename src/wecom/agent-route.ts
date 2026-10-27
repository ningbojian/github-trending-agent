import type { LanguageModel } from 'ai';
import { llmFor, type LlmChoice } from '../agent/llm.js';
import { resolveGithubToken } from '../agent/github-token.js';
import { loadRepoSummaries } from '../agent/repo-summary.js';
import { searchTrending, type SearchResultItem } from '../agent/search.js';
import {
  readSubscription,
  removeSubscriptionTerm,
  type SubscriptionSnapshot,
} from '../agent/subscription-store.js';
import { createTools, type ToolContext } from '../agent/tools.js';
import { runToolLoopSafe, type GenerateTextFn } from '../agent/tool-loop.js';
import { githubClient, type GithubClient } from '../github/client.js';
import type { SearchQuery } from '../agent/parse-query.js';
import { note, traceError } from '../obs/trace.js';
import { sendWeComText } from './api.js';
import { MAX_TEXT_BYTES } from './text.js';
import type { InboundMessage } from './router.js';

/**
 * 工具链路的执行外壳：把「规则前置判定要走工具」翻译成一次模型循环 + 一条回复。
 *
 * 三条边界：
 * 1. **谁付钱**：只有用户自己的 Key（`choice.kind === 'user'`）才跑模型。
 *    没有 Key 就立刻返回 false，交给原有「规则解析 + 读共享缓存」链路——
 *    零模型调用是产品承诺，不是优化项。
 * 2. **失败就退回**：超时、报错、空文本一律返回 false，由调用方继续走检索。
 *    工具是增强，不能让「本可以正常回答」的请求变成报错。
 * 3. **编号只认工具结果**：模型调用过 `search_trending` 时，列表用同一批
 *    items 交给 `formatItems` 排版——「收藏 N」的序号因此永远指向用户看到的
 *    那份列表，模型是否复述、如何复述都不影响。
 *
 * 本模块刻意不 import `reply.ts`（排版函数由调用方注入）：reply 依赖本模块，
 * 反向 import 会成环，而环正是「工具调用悄悄退回旧路径」这类 bug 的温床。
 */

/** 工具回复的系统提示词：事实边界写死，语气交给模型。 */
export const AGENT_SYSTEM_PROMPT = [
  '你是「GitHub 趋势助手」，一个中文技术选型顾问。',
  '规则：',
  '1. 只能使用工具返回的事实（star 数、日期、健康度、订阅设置），不要编造数字或链接。',
  '2. 工具失败就如实说明原因（限流、没找到），不要假装有数据。',
  '3. 直接给结论，再给一两条理由；控制在 200 字以内。',
  '4. 需要列表时必须调用 search_trending，不要手写仓库列表。',
  '5. 不能代替用户开通或退订订阅，只能查看或删掉关键词。',
  '6. 用纯文本回答，链接写成行尾裸 URL。',
].join('\n');

export interface AgentRouteOptions {
  /** 互动烧用户自己的 Key；`none` 时本函数直接放弃。 */
  choice: LlmChoice;
  /** 列表排版（由 reply.ts 注入 `formatSearchReply`）。 */
  formatItems: (items: SearchResultItem[], summaries: Map<string, string>) => string;

  // ---- 以下全部可注入，测试与评测用；生产走默认实现 ----
  model?: LanguageModel;
  generate?: GenerateTextFn;
  send?: (userid: string, text: string) => Promise<void>;
  search?: (query: SearchQuery, userid: string) => Promise<SearchResultItem[]>;
  github?: GithubClient;
  readSubscription?: (userid: string) => Promise<SubscriptionSnapshot | null>;
  removeTerm?: (userid: string, term: string) => Promise<{ removed: boolean; keywords: string[] }>;
  getToken?: (userid: string) => Promise<{ token: string | null; source: string }>;
  loadSummaries?: (
    items: SearchResultItem[],
    choice: LlmChoice,
  ) => Promise<Map<string, string>>;
  now?: () => number;
  timeoutMs?: number;
  maxSteps?: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

async function summariesSafe(
  items: SearchResultItem[],
  choice: LlmChoice,
  loader: (items: SearchResultItem[], choice: LlmChoice) => Promise<Map<string, string>>,
): Promise<Map<string, string>> {
  try {
    return await loader(items, choice);
  } catch (err) {
    // 简介失败只让回复少一段文字，绝不影响列表本身。
    console.warn('[agent-route] summaries failed:', err instanceof Error ? err.message : err);
    return new Map();
  }
}

/**
 * 尝试用工具回答。返回 true = 已经发过回复，调用方应立即 return；
 * false = 没有可用结果，调用方继续原有检索链路（不是错误）。
 */
export async function tryAgentReply(
  msg: InboundMessage,
  options: AgentRouteOptions,
): Promise<boolean> {
  if (options.choice.kind !== 'user') {
    note('agent-route', 'no-key');
    return false;
  }

  // 用对象而不是裸变量：赋值发生在工具回调里，TS 的控制流分析看不到它，
  // 裸 `let` 会在下面的判断处被收窄成 never。
  const captured: { items: SearchResultItem[] | null } = { items: null };
  const search = options.search ?? searchTrending;

  const ctx: ToolContext = {
    wecomUserid: msg.fromUserName,
    now: options.now ?? (() => Date.now()),
    github: options.github ?? githubClient,
    search: async (query, userid) => {
      const items = await search(query, userid);
      captured.items = items;
      return items;
    },
    getToken: options.getToken ?? ((userid) => resolveGithubToken(userid)),
    readSubscription: options.readSubscription ?? readSubscription,
    removeTerm: options.removeTerm ?? removeSubscriptionTerm,
  };

  const model = options.model ?? llmFor(options.choice.config);
  const outcome = await runToolLoopSafe(
    { system: AGENT_SYSTEM_PROMPT, prompt: msg.content },
    {
      model,
      tools: createTools(ctx),
      generate: options.generate,
      timeoutMs: options.timeoutMs,
      maxSteps: options.maxSteps,
    },
  );

  if (outcome === null) {
    note('agent-route', 'fallback');
    return false;
  }
  note('agent-route', `steps=${outcome.steps} tools=${outcome.tools.join(',') || 'none'}`);

  let reply = outcome.text;
  const searched = captured.items;
  if (searched !== null && searched.length > 0 && outcome.tools.includes('search_trending')) {
    const summaries = await summariesSafe(
      searched,
      options.choice,
      options.loadSummaries ?? loadRepoSummaries,
    );
    const list = options.formatItems(searched, summaries);
    if (list !== '') {
      const combined = `${reply}\n\n${list}`;
      // 超长时保列表：模型文字是锦上添花，编号列表才是「收藏 N」的锚点。
      reply = byteLength(combined) <= MAX_TEXT_BYTES ? combined : list;
    }
  }

  const send = options.send ?? sendWeComText;
  try {
    await send(msg.fromUserName, reply);
  } catch (err) {
    traceError(err);
    throw err;
  }
  note('agent-send', `${byteLength(reply)} 字节`);
  return true;
}
