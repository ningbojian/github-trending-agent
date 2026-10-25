/**
 * 意图边界（可替换的一级判断）。
 *
 * 现状是先跑这里的**零成本规则**，规则拿不准才交给 LLM 的结构化解析
 * （`parseSearchQuery` 的 `intent` 字段）。规则只拦**高置信**的明显无关输入，
 * 拿不准一律返回 null —— 漏判退化成搜索（老行为），绝不误伤「今天有什么」
 * 这类正常提问。
 *
 * 这个函数就是将来替换成小模型的接口位：换成 ECS 上的分类模型时，
 * 只需在这里改实现（或加一个 `INTENT_ENDPOINT` 分支），调用方不用动。
 */
export type Intent = 'search' | 'about' | 'off_topic';

/** 「你是谁 / 你能干什么」——产品介绍，不是搜索。 */
const ABOUT_PATTERNS: RegExp[] = [
  /^(你|您)(是|叫)(谁|什么|啥|干嘛的|做什么的|机器人|ai|人工智能|什么名字|啥名字)/i,
  /^(你|您)(都)?(会|能|可以)(做|干|帮|提供)(什么|啥|哪些|嘛|么)/,
  /^(你|您)有(什么|哪些|啥)(功能|能力|用)/,
  // 末尾锚定：只认「介绍一下你(自己)」这类整句，
  // 「介绍下你用过的 python 库」是正常检索，不能被误判成产品介绍。
  /^(介绍|说说)(一下|下)?(你|您)(自己)?$/,
  /^自我介绍/,
  /^(你|您)(能|可以)?帮(我|我们)?(做|干)(什么|啥|嘛)/,
];

/**
 * 明显无关的话题词。命中即判 off_topic，但有两道闸：
 * 消息里出现任何「本产品领域词」（github/repo/项目/开源…）→ 不拦；
 * 消息过长（>30 字）→ 不拦，避免把长句搜索误判成闲聊。
 */
const OFF_TOPIC_TOPICS: Array<{ word: RegExp; label: string }> = [
  { word: /天气|气温|温度|下雨|下雪|台风|雾霾|空气质量/, label: 'weather' },
  { word: /股票|股价|基金|汇率|比特币|币价|涨停|期货/, label: 'finance' },
  { word: /讲个笑话|说个笑话|写首诗|写一首诗|写作文|作首诗/, label: 'writing' },
  { word: /翻译成|翻译为|翻译一下|帮我翻译/, label: 'translate' },
  { word: /现在几点|几点了|今天几号|今天星期几|现在什么时间/, label: 'time' },
];

/** 领域词：出现任意一个就说明用户在问本产品能回答的事。 */
const DOMAIN_HINTS =
  /github|git\b|仓库|项目|repo|star|开源|代码|编程|语言|框架|库|榜|热门|趋势|排行/i;

/** 超过这个长度就交给 LLM，规则只认短句。 */
const RULE_MAX_CHARS = 30;

/** 去掉首尾空白与句末标点，便于 `^` 锚定的模式匹配。 */
function normalize(text: string): string {
  return text.trim().replace(/[。！？!?~～\s]+$/g, '');
}

/**
 * 规则分类：命中返回 'about' / 'off_topic'，拿不准返回 null。
 * 纯函数、零 I/O、零 token。
 */
export function classifyByRules(text: string): Intent | null {
  const normalized = normalize(text);
  if (!normalized) {
    return null;
  }

  for (const pattern of ABOUT_PATTERNS) {
    if (pattern.test(normalized)) {
      return 'about';
    }
  }

  if (normalized.length > RULE_MAX_CHARS || DOMAIN_HINTS.test(normalized)) {
    return null;
  }
  for (const topic of OFF_TOPIC_TOPICS) {
    if (topic.word.test(normalized)) {
      return 'off_topic';
    }
  }
  return null;
}
