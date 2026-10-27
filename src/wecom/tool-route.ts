/**
 * 工具路由的规则前置（纯函数，不碰模型/DB）。
 *
 * 为什么不是「每条消息都交给模型决定用不用工具」：
 * - 互动链路里绝大多数消息是普通检索，模型选工具只会让回答慢两三秒、再花一次 token；
 * - 用户没配 Key 时根本没有模型可用（`LlmChoice = none`），必须有一条不花钱的路；
 * - 规则能覆盖的说法（点名仓库、问维护状态、改订阅）本来就意图明确，
 *   让模型重新判断只会引入不确定性。
 *
 * 因此规则只做一件事：**筛出确实需要工具的说法**，其余一律落回原有检索链路
 * （零模型调用）。误判的代价不对称——把检索误送进工具循环只是多花一次调用，
 * 把工具请求误当检索则会答非所问，所以倾向宁可漏、不可错。
 */

import { parseRepoRef } from '../github/repo-ref.js';

export type AgentToolName = 'deep_dive_repo' | 'repo_health' | 'manage_subscription';

export type ToolRoute =
  | { kind: 'tools'; tool: AgentToolName; repo: string | null }
  | { kind: 'search' };

/**
 * 改订阅：必须同时出现「订阅」和修改动词。
 * 「订阅里的词是什么意思」是提问不是修改，不能命中。
 */
const MANAGE_SUBSCRIPTION_RE =
  /(取消|删掉?|去掉|移除|更改|调整|修改).*订阅|订阅.*(删掉?|去掉|移除|更改|调整|修改)/;

/** 维护状态类提问（有仓库名或「这个项目」才走工具）。 */
const HEALTH_RE = /(靠不靠谱|靠谱吗|不靠谱|风险|还在维护|维护吗|值得用|能用吗|好用吗|安全吗|健康)/;

/** 指向「刚说的那个仓库」的说法——没有仓库名时，模型要靠检索补上下文。 */
const DEMONSTRATIVE_RE = /(这个项目|这个仓库|这个库|该项目|这个工具)/;

/** 深挖类动词（只在与仓库名同现时生效）。 */
const DEEP_DIVE_RE =
  /(深挖|介绍|简介|讲讲|说说|聊聊|看看|看一下|分析|怎么样|如何|readme|release|发布|版本|最近更新|活跃)/i;

/** 明确的检索意图：即使句子里有 owner/repo，也只是拿它当关键词。 */
const SEARCH_INTENT_RE = /(类似|相似|替代|对比|区别|推荐|找一下|搜一下|搜索)/;

const URL_RE = /https?:\/\/(?:www\.)?github\.com\/[^\s，。；、）)]+/i;
const TOKEN_RE = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;

/**
 * 从一句话里找出第一个像仓库的片段，返回**原文片段**（工具参数直接用）。
 * 要求 owner 或 name 至少含一个 ASCII 字母，避免把 `10/27`、`2/3` 当仓库。
 */
export function findRepoRef(text: string): string | null {
  const url = text.match(URL_RE)?.[0];
  if (url !== undefined && parseRepoRef(url) !== null) {
    return url;
  }

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const raw = match[0];
    if (!/[A-Za-z]/.test(raw)) continue;
    if (parseRepoRef(raw) !== null) {
      return raw;
    }
  }
  return null;
}

/**
 * 决定一条**已过命令路由**的文本是否需要工具。
 * 调用方是搜索路径：返回 `search` 时沿用原有「规则意图 → 解析 → 检索」链路。
 */
export function routeToTools(content: string): ToolRoute {
  const text = content.trim();
  if (text === '') {
    return { kind: 'search' };
  }

  if (MANAGE_SUBSCRIPTION_RE.test(text)) {
    return { kind: 'tools', tool: 'manage_subscription', repo: null };
  }

  const repo = findRepoRef(text);

  if (repo !== null && HEALTH_RE.test(text)) {
    return { kind: 'tools', tool: 'repo_health', repo };
  }

  if (repo === null && DEMONSTRATIVE_RE.test(text) && HEALTH_RE.test(text)) {
    // 「这个项目靠不靠谱」没有仓库名：让模型先检索、再对候选做健康度判断。
    return { kind: 'tools', tool: 'repo_health', repo: null };
  }

  if (repo !== null) {
    if (SEARCH_INTENT_RE.test(text)) {
      return { kind: 'search' };
    }
    if (DEEP_DIVE_RE.test(text) || isBareRepoRef(text, repo)) {
      return { kind: 'tools', tool: 'deep_dive_repo', repo };
    }
  }

  return { kind: 'search' };
}

/** 整句就是一个仓库引用（允许「看看」这类无信息量的前缀）。 */
function isBareRepoRef(text: string, repo: string): boolean {
  const rest = text
    .replace(repo, '')
    .replace(/^(看看|看下|麻烦|帮我|请)/, '')
    .replace(/[。！？!?；;，,、\s]+/g, '')
    .trim();
  return rest === '';
}
