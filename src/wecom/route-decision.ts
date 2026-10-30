/**
 * 文本消息的纯路由决策（不碰 DB、不发消息、不读配置）。
 *
 * 从 router.ts 抽出来只为一件事：评测能直接观察「这句话走了哪条路」，
 * 而不必启动整个分发链路。router 仍负责调用 handler 与文案，本模块只回答
 * 「这是哪个 handler」或「该回哪条用法提示」。
 *
 * 顺序即优先级，任何改动都必须保持与旧 router 完全一致——
 * tests/router.test.ts 原样全绿就是这条重构的验收标准。
 */

import { NUMBER_TOKEN_PATTERN } from './cn-number.js';

/** 能处理文本指令的 handler 键（与 router.Handlers 一一对应）。 */
export type HandlerKey =
  | 'help'
  | 'unfavorite'
  | 'favorite'
  | 'list'
  | 'mySubscription'
  | 'memory'
  | 'notInterested'
  | 'interested'
  | 'bind'
  | 'subscribe'
  | 'cancelSubscription'
  | 'unsubscribe'
  | 'digestCount'
  | 'pushTime'
  | 'pushInterval'
  | 'setModel'
  | 'myModel'
  | 'clearModel'
  | 'track'
  | 'untrack'
  | 'myTracking'
  | 'panel'
  | 'search';

/** 疑似命令的用法提示键（文案由 router 映射）。 */
export type UsageKey =
  | 'favorite'
  | 'unfavorite'
  | 'list'
  | 'mySubscription'
  | 'memory'
  | 'bind'
  | 'unsubscribe'
  | 'setModel'
  | 'clearModel'
  | 'myModel'
  | 'cancelSubscription'
  | 'track'
  | 'untrack'
  | 'myTracking';

export type RouteDecision =
  | { kind: 'handler'; handler: HandlerKey }
  | { kind: 'usage'; usage: UsageKey };

/** 「取消收藏 <数字>」——须先于「收藏 N」判断。 */
const UNFAVORITE_PATTERN = new RegExp(`^取消收藏\\s*${NUMBER_TOKEN_PATTERN}$`);

/** 「收藏 <数字>」——支持有/无空格、阿拉伯/中文数字。 */
const FAVORITE_PATTERN = new RegExp(`^收藏\\s*${NUMBER_TOKEN_PATTERN}$`);

/** 「订阅 …」——前缀匹配（「退订」首字为「退」，不会被吞掉）。 */
const SUBSCRIBE_PATTERN = /^订阅/;

/**
 * 「取消订阅 <关键词>」——动词后必须是空白或句子结束（裸「取消订阅」命中，
 * 由 handler 回用法提示；「取消订阅rpa」无空白 → 疑似命令提示）。
 */
const CANCEL_SUBSCRIPTION_PATTERN = /^取消订阅(?:\s|$)/;

/**
 * 「不感兴趣 …」/「感兴趣 …」——动词后必须是空白或句子结束。
 * 具体作用在哪些条目（整批 / 序号 / 仓库名）由 handler 解析；
 * 这里只负责「别把口味指令当搜索词发出去」。
 */
const NOT_INTERESTED_PATTERN = /^不感兴趣(?:\s|$)/;
const INTERESTED_PATTERN = /^感兴趣(?:\s|$)/;

/**
 * 长期记忆：前缀即命令。「记住这个仓库 astral-sh/ruff」是让助手记住，
 * 不是搜仓库；正文（可能为空）交给 handler 校验并回用法提示。
 */
const REMEMBER_PATTERN = /^记住/;
const FORGET_PATTERN = /^忘掉/;

/** 「条数 …」——前缀匹配（裸「条数」/非法输入由 handler 回用法提示）。 */
const DIGEST_COUNT_PATTERN = /^条数/;

/**
 * 「每天 H 点」/「推送时间 HH:MM」——**锚定整句**（时间可省略：裸「推送时间」
 * 由 handler 回用法提示）。「每天 star 最多的项目」是合法搜索，绝不能被吞。
 * 尾标点在分发前已剥除（「每天 9 点。」同样命中）。
 * 注意：分钟 token 必须写成 `(?:TOKEN)?` —— NUMBER_TOKEN_PATTERN 自带 `+`，
 * 直接 `TOKEN?` 会变成惰性 `+?`（分钟变成必填），「每天 9 点」就永远不命中。
 */
const PUSH_TIME_PATTERN = new RegExp(
  `^(每天|推送时间)(?:\\s*${NUMBER_TOKEN_PATTERN}(?:\\s*[:：点时]\\s*(?:${NUMBER_TOKEN_PATTERN})?)?\\s*分?)?\\s*$`,
);

/**
 * 「每 N 天(推送|简报)?」——**锚定整句**（N 为阿拉伯/中文数字）。
 * 「每两天更新的项目」等带后缀的句子不命中，照常落搜索。
 * 与 PUSH_TIME_PATTERN 互斥：「每天」无 N 不命中本式；「每 2 天」无「每天」前缀不命中上式。
 */
const PUSH_INTERVAL_PATTERN = new RegExp(
  `^每\\s*${NUMBER_TOKEN_PATTERN}\\s*天(推送|简报)?$`,
);

/** 跟踪：`取消追踪` 先于 `追踪`；`关注` 必须带空白，避免吞掉「关注度高的项目」。 */
const MY_TRACKING_PATTERN = /^(我的追踪|追踪列表|跟踪列表)$/;
/** 允许「取消追踪1」「取消追踪一」（无空格），数字紧跟也能分发到 handler。 */
const UNTRACK_PATTERN = /^取消(追踪|跟踪|关注)(?:\s|$|[0-9一二三四五六七八九十两])/;
const TRACK_PATTERN = /^(追踪|跟踪|关注)\s+/;

/** 尾部中英文标点（精确/前缀分发与疑似命令判定前统一剥除，「帮助。」也能命中）。 */
const TRAILING_PUNCT_RE = /[。！？!?；;，,．.…]+$/;

/**
 * 归一化指令文本：去首尾空白 + 剥尾部标点。
 * 分发给 handler 时用的就是这份文本——handler 还会用自己的正则再校验一次。
 */
export function normalizeCommandText(content: string): string {
  return content
    // 多余空白（含全角空格）收敛成一个：用户手滑多打一个空格，
    // 「深挖  vercel/next.js」不该掉进搜索路径。
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_PUNCT_RE, '')
    .trim();
}

/**
 * 疑似命令判定：精确/前缀分发全部未命中、即将 fallthrough 到搜索前，
 * 若内容以命令词开头却不是合法指令（如「收藏一下」「我的收藏列表」），
 * 回对应用法提示而不是把命令错字当搜索词发出去。
 * 「帮助」刻意不在列：长句（「帮助我找 python」）是合法的搜索请求，只精确匹配。
 */
export function suspectedCommandUsage(content: string): UsageKey | null {
  if (content.startsWith('取消收藏')) {
    return 'unfavorite';
  }
  if (content.startsWith('收藏')) {
    return 'favorite';
  }
  if (content.startsWith('我的收藏')) {
    return 'list';
  }
  if (content.startsWith('我的订阅')) {
    return 'mySubscription';
  }
  if (content.startsWith('我的记忆')) {
    return 'memory';
  }
  if (content.startsWith('取消订阅')) {
    return 'cancelSubscription';
  }
  if (content.startsWith('绑定')) {
    return 'bind';
  }
  if (content.startsWith('退订')) {
    return 'unsubscribe';
  }
  // 三个模型命令同形的前缀兜底：错字/带参数都别被当成搜索词发出去。
  if (content.startsWith('设置模型')) {
    return 'setModel';
  }
  if (content.startsWith('清除模型')) {
    return 'clearModel';
  }
  if (content.startsWith('我的模型')) {
    return 'myModel';
  }
  // 跟踪命令的错字/缺参数：别当搜索词发出去。裸「关注」不在此列
  // （「关注度高的项目」是合法搜索）。精确命令先判，避免「追踪列表」被当成「追踪」。
  if (content.startsWith('我的追踪') || content.startsWith('追踪列表')) {
    return 'myTracking';
  }
  if (content.startsWith('取消追踪') || content.startsWith('取消跟踪')) {
    return 'untrack';
  }
  if (content.startsWith('追踪') || content.startsWith('跟踪')) {
    return 'track';
  }
  return null;
}

/**
 * 决定一条**已归一化**文本消息的去向。
 * 传原始文本也行——内部会再归一化一次（幂等）。
 */
export function decideTextRoute(content: string): RouteDecision {
  const text = normalizeCommandText(content);
  if (text === '帮助' || text === '帮助 全部' || text === '帮助全部') {
    return { kind: 'handler', handler: 'help' };
  }
  if (UNFAVORITE_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'unfavorite' };
  }
  if (FAVORITE_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'favorite' };
  }
  if (text === '我的收藏') {
    return { kind: 'handler', handler: 'list' };
  }
  if (text === '我的订阅') {
    return { kind: 'handler', handler: 'mySubscription' };
  }
  if (text === '我的记忆') {
    return { kind: 'handler', handler: 'memory' };
  }
  if (text === '我的面板' || text === '面板') {
    return { kind: 'handler', handler: 'panel' };
  }
  if (MY_TRACKING_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'myTracking' };
  }
  if (UNTRACK_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'untrack' };
  }
  if (TRACK_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'track' };
  }
  if (REMEMBER_PATTERN.test(text) || FORGET_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'memory' };
  }
  if (NOT_INTERESTED_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'notInterested' };
  }
  if (INTERESTED_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'interested' };
  }
  if (text === '绑定') {
    return { kind: 'handler', handler: 'bind' };
  }
  if (SUBSCRIBE_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'subscribe' };
  }
  if (CANCEL_SUBSCRIPTION_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'cancelSubscription' };
  }
  if (text === '退订') {
    return { kind: 'handler', handler: 'unsubscribe' };
  }
  if (DIGEST_COUNT_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'digestCount' };
  }
  if (PUSH_TIME_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'pushTime' };
  }
  if (PUSH_INTERVAL_PATTERN.test(text)) {
    return { kind: 'handler', handler: 'pushInterval' };
  }
  if (text === '设置模型') {
    return { kind: 'handler', handler: 'setModel' };
  }
  if (text === '我的模型') {
    return { kind: 'handler', handler: 'myModel' };
  }
  if (text === '清除模型') {
    return { kind: 'handler', handler: 'clearModel' };
  }
  const usage = suspectedCommandUsage(text);
  if (usage !== null) {
    return { kind: 'usage', usage };
  }
  return { kind: 'handler', handler: 'search' };
}
