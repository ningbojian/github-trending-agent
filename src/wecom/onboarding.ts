import { eq } from 'drizzle-orm';
import { MAX_INTERVAL_DAYS } from '../agent/digest.js';
import { db } from '../db/client.js';
import { subscribers } from '../db/schema.js';
import { sendWeComText } from './api.js';
import { parseCnNumber } from './cn-number.js';
import type { InboundMessage } from './router.js';

/**
 * 订阅开通与偏好设置（Task 13）：
 * - ensureSubscriber：首条消息自动开通订阅者行（新用户返回 true，router 据此先发欢迎语）；
 *   DB 错误 log warn 后 fail-open 返回 false —— 一条坏 insert 绝不阻塞聊天分发
 * - handleSubscribe：「订阅 <偏好>」→ preferences = { languages: [], keywords: tokens }
 *   整体替换（简单可预期；tokens 与 Task 10 简报的 keywords 提升同形），
 *   并同写 active: true —— 退订后再次订阅即恢复每日简报
 * - handleUnsubscribe：「退订」（精确匹配）→ active=false；不触碰 GitHub 绑定与收藏
 * Task 5 新增：
 * - handlePushTime：「每天 H 点」/「推送时间 HH:MM」→ preferences.pushTime（北京时间）
 * - handlePushInterval：「每 N 天」→ preferences.intervalDays（1–30）
 */

/**
 * 新用户欢迎语（Task 6 起由 welcome.ts 定义并在此转出，保持既有导入路径稳定）。
 */
export { WELCOME_MESSAGE } from './welcome.js';

/** 裸「订阅」（无可解析关键词）时的用法提示。 */
export const SUBSCRIBE_USAGE_REPLY =
  '用法：「订阅 <偏好>」，多个偏好用逗号、顿号或空格分隔，例如：订阅 python,ai,agent';

/** 「订阅」更新成功的确认文案（回显当前偏好关键词）。 */
export const SUBSCRIBE_REPLY_PREFIX = '✅ 已订阅每日简报，当前偏好关键词：';

/** 「订阅」更新成功的确认文案尾句。 */
export const SUBSCRIBE_REPLY_SUFFIX = '（命中关键词的项目会优先展示）';

/** 「退订」确认文案（简报停止推送；GitHub 绑定与收藏不受影响）。 */
export const UNSUBSCRIBE_REPLY =
  '已退订每日简报，之后不再推送。发「订阅 <偏好>」可随时重新订阅。';

/** 「订阅」更新失败的兜底文案。 */
export const SUBSCRIBE_FAILURE_REPLY = '订阅失败，请稍后再试';

/** 「退订」更新失败的兜底文案。 */
export const UNSUBSCRIBE_FAILURE_REPLY = '退订失败，请稍后再试';

/** 「条数 N」设置成功的确认文案前缀。 */
export const DIGEST_COUNT_REPLY_PREFIX = '✅ 每日简报条数已设为 ';

/** 「条数 N」确认文案尾句（同时声明合法范围）。 */
export const DIGEST_COUNT_REPLY_SUFFIX = '（1–20）';

/** 「条数 N」用法/非法输入提示（不写库）。 */
export const DIGEST_COUNT_USAGE_REPLY =
  '用法：「条数 N」，N 为 1–20 的整数，例如：条数 5';

/** 「条数 N」更新失败的兜底文案。 */
export const DIGEST_COUNT_FAILURE_REPLY = '条数设置失败，请稍后再试';

/** 「每天 H 点」/「推送时间 HH:MM」确认文案（回执必须注明北京时间）。 */
export const PUSH_TIME_REPLY_PREFIX = '✅ 简报推送时间已设为 ';
export const PUSH_TIME_REPLY_SUFFIX = '（北京时间）';

/** 「每天 …」/「推送时间 …」用法/非法输入提示（不写库）。 */
export const PUSH_TIME_USAGE_REPLY =
  '用法：「每天 H 点」或「推送时间 HH:MM」（北京时间，24 小时制），例如：每天 9 点、推送时间 21:30';

/** 「每天 …」/「推送时间 …」更新失败的兜底文案。 */
export const PUSH_TIME_FAILURE_REPLY = '推送时间设置失败，请稍后再试';

/** 「每 N 天」确认文案（回执声明合法范围）。 */
export const INTERVAL_REPLY_PREFIX = '✅ 简报推送间隔已设为每 ';
export const INTERVAL_REPLY_SUFFIX = ' 天（1–30，未到间隔不重复推送）';

/** 「每 N 天」用法/非法输入提示（不写库）。 */
export const INTERVAL_USAGE_REPLY =
  '用法：「每 N 天」，N 为 1–30 的整数，例如：每 2 天';

/** 「每 N 天」更新失败的兜底文案。 */
export const INTERVAL_FAILURE_REPLY = '推送间隔设置失败，请稍后再试';

/**
 * 问「你是谁 / 能干什么」时的产品介绍（3 行：身份 + 可用问法 + 帮助入口）。
 * 不检索、不写 search_caches —— 「收藏 N」必须始终指向最后一次真实列表。
 */
export const ABOUT_REPLY = [
  '我是 GitHub 热榜助手：每天把你关注方向里增长最快的开源项目整理成简报推给你，也可以直接向我提问。',
  '可以这样问：「本周 python 的 ai 项目」「star 增长最快的 rust 项目」「前 5 个新项目」。',
  '发「帮助」查看全部指令。',
].join('\n');

/**
 * 明显与 GitHub 找项目无关的话题（天气、股票、翻译、写诗、报时…）的边界引导。
 * 同样不检索、不写缓存。
 */
export const OFF_TOPIC_REPLY = [
  '这个问题我答不了——我只负责 GitHub 热门项目。',
  '可以这样问：「本周 python 的 ai 项目」「star 增长最快的 rust 项目」「前 5 个新项目」。',
  '发「帮助」查看全部指令。',
].join('\n');

// ---------------------------------------------------------------------------
// handleHelp
// ---------------------------------------------------------------------------

/** 「帮助」回复：全中文完整用法说明（覆盖全部用户指令）。 */
export const HELP_MESSAGE = [
  '完整用法（回复对应指令即可）：',
  '· 每日简报：加入即自动开通（默认每天 09:00 推送），只推有增长的新项目，没有就不打扰；发「退订」可停止。',
  '· 口味：看完简报回「感兴趣」或「不感兴趣」，以后会多推/少推这个方向（连提两次才真正生效）。',
  '· 自然语言搜索：直接发送描述即可，如「本周 python 的 ai 项目」；条数用「前 5 个」控制。',
  '· 收藏：搜索结果或简报后回复「收藏 N」，收藏第 N 条并同步 star（需先发「绑定」授权 GitHub）。',
  '· 取消收藏：回复「取消收藏 N」，取消第 N 条收藏并同步取消 star。',
  '· 我的收藏：回复「我的收藏」，查看全部已收藏项目。',
  '· 绑定：回复「绑定」，跳转 GitHub 授权页完成授权。',
  '· 订阅：回复「订阅 <偏好>」设置每日简报偏好，如「订阅 python,ai」。',
  '· 退订：回复「退订」，停止每日简报（可随时重新订阅）。',
  '· 条数：回复「条数 N」自定义每日简报条数（1–20，仅影响简报），如「条数 5」。',
  '· 推送时间：回复「每天 H 点」或「推送时间 HH:MM」设置每日推送时间（北京时间），如「每天 9 点」。',
  '· 推送间隔：回复「每 N 天」设置推送间隔（1–30 天，1 为每天），如「每 2 天」。',
  '· 设置模型：回复「设置模型」，在网页里填自己的 AI Key（互动用你的额度，不占本服务额度）；发「我的模型」查看、「清除模型」删除。',
].join('\n');

/**
 * 「帮助」handler（router 精确匹配「帮助」后分发）：
 * 发送完整用法说明；不读不写 DB。发送失败以 rejected promise 传播，
 * 由 router 的 dispatchSafely 捕获并回发兜底文案。
 */
export async function handleHelp(msg: InboundMessage): Promise<void> {
  await sendWeComText(msg.fromUserName, HELP_MESSAGE);
}

// ---------------------------------------------------------------------------
// ensureSubscriber
// ---------------------------------------------------------------------------

/**
 * 确保发送者已有订阅者行：缺失则 insert（active=true、空偏好）并返回 true（新用户）；
 * 已存在返回 false。任何 DB 错误 log warn 后返回 false（fail-open，不向外抛）。
 * 由 router 在 text 分发前调用；display_name 暂无来源（企微回调只带 userid），
 * 按 notNull 约束写空串占位。
 */
export async function ensureSubscriber(msg: InboundMessage): Promise<boolean> {
  try {
    const rows = await db()
      .select()
      .from(subscribers)
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    if (rows.length > 0) {
      return false;
    }
    await db()
      .insert(subscribers)
      .values({
        wecomUserid: msg.fromUserName,
        displayName: '',
        preferences: { languages: [], keywords: [] },
        active: true,
      });
    return true;
  } catch (err) {
    console.warn('ensureSubscriber failed:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// handleSubscribe / handleUnsubscribe
// ---------------------------------------------------------------------------

/** 「订阅」前缀（与 router 的分发正则保持一致；「退订」首字不同，不会互相吞）。 */
const SUBSCRIBE_PREFIX = '订阅';

/** 偏好分隔符：中英文逗号、顿号、空白 + 中文句读与英文句读（。！？!?；;）。 */
const KEYWORD_SEPARATOR_RE = /[,，、。！？!?；;\s]+/;

/** token 内标点清洗：与 parse-query 同一字符集（剔除后空串由调用方丢弃）。 */
const KEYWORD_PUNCT_RE = /[。！？!?；;，,、()（）]/g;

/**
 * 解析偏好 tokens：按 中文/英文逗号、顿号、句读、空白 切分，
 * 剔除 token 内中英文标点，trim 后丢弃空串（「订阅 AI。」→ ['AI']）。
 */
function parseKeywords(rest: string): string[] {
  return rest
    .split(KEYWORD_SEPARATOR_RE)
    .map((token) => token.replace(KEYWORD_PUNCT_RE, '').trim())
    .filter((token) => token.length > 0);
}

function subscribedReply(keywords: string[]): string {
  return `${SUBSCRIBE_REPLY_PREFIX}${keywords.join('、')}${SUBSCRIBE_REPLY_SUFFIX}`;
}

/**
 * 「订阅 <偏好>」handler：
 * - 前缀不匹配 → 静默返回（router 层已拦；直接调用同此守卫）
 * - 无可解析关键词（裸「订阅」）→ 用法提示，不写库
 * - 读-合并-写：languages/keywords 整体替换（languages 重置为空数组），
 *   但保留原 preferences.digestCount / pushTime / intervalDays
 *   （「条数 N」「每天 H 点」「每 N 天」的设置不被订阅指令清掉）
 * - 同时写 active: true：退订（active=false）后再次订阅即恢复每日简报，
 *   与 UNSUBSCRIBE_REPLY / HELP / README 承诺的「可随时重新订阅」一致
 */
export async function handleSubscribe(msg: InboundMessage): Promise<void> {
  try {
    const content = msg.content.trim();
    if (!content.startsWith(SUBSCRIBE_PREFIX)) {
      return;
    }
    const tokens = parseKeywords(content.slice(SUBSCRIBE_PREFIX.length));
    if (tokens.length === 0) {
      await sendWeComText(msg.fromUserName, SUBSCRIBE_USAGE_REPLY);
      return;
    }
    const rows = await db()
      .select()
      .from(subscribers)
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    const previous = rows[0]?.preferences;
    const preferences: {
      languages: string[];
      keywords: string[];
      digestCount?: number;
      pushTime?: string;
      intervalDays?: number;
    } = {
      languages: [],
      keywords: tokens,
    };
    if (typeof previous?.digestCount === 'number') {
      preferences.digestCount = previous.digestCount;
    }
    if (typeof previous?.pushTime === 'string') {
      preferences.pushTime = previous.pushTime;
    }
    if (typeof previous?.intervalDays === 'number') {
      preferences.intervalDays = previous.intervalDays;
    }
    await db()
      .update(subscribers)
      .set({ preferences, active: true })
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    await sendWeComText(msg.fromUserName, subscribedReply(tokens));
  } catch (err) {
    console.error('handleSubscribe failed:', err);
    try {
      await sendWeComText(msg.fromUserName, SUBSCRIBE_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('subscribe fallback reply failed:', fallbackErr);
    }
  }
}

/**
 * 「退订」handler（精确匹配）：
 * - 写 active=false（仅此字段；GitHub 绑定与收藏原样保留）→ 中文确认
 * - digest.ts 的 pushDigests 固化 WHERE active = true，退订即停止每日简报
 */
export async function handleUnsubscribe(msg: InboundMessage): Promise<void> {
  try {
    if (msg.content.trim() !== '退订') {
      return;
    }
    await db()
      .update(subscribers)
      .set({ active: false })
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    await sendWeComText(msg.fromUserName, UNSUBSCRIBE_REPLY);
  } catch (err) {
    console.error('handleUnsubscribe failed:', err);
    try {
      await sendWeComText(msg.fromUserName, UNSUBSCRIBE_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('unsubscribe fallback reply failed:', fallbackErr);
    }
  }
}

// ---------------------------------------------------------------------------
// handleDigestCount
// ---------------------------------------------------------------------------

/** 「条数」前缀（与 router 的分发正则保持一致）。 */
const DIGEST_COUNT_PREFIX = '条数';

/**
 * 「条数 N」handler（router 按「条数」前缀分发）：
 * - 解析「条数 N」：N 必须是 1–20 整数；裸「条数」/非数字/越界 → 用法提示，不写库
 *   （越界 REJECTED 而非静默 clamp：用户显式输入了数字，静默改值会误导）
 * - 读-合并-写：只更新 preferences.digestCount，保留原 languages/keywords
 * - digest.ts 消费端再做 clamp 1–20 + 默认 10 兜底（脏数据防御双保险）
 */
export async function handleDigestCount(msg: InboundMessage): Promise<void> {
  try {
    const content = msg.content.trim();
    const match = new RegExp(`^${DIGEST_COUNT_PREFIX}\\s*(\\d+)$`).exec(content);
    const n = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      await sendWeComText(msg.fromUserName, DIGEST_COUNT_USAGE_REPLY);
      return;
    }
    const rows = await db()
      .select()
      .from(subscribers)
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    const previous = rows[0]?.preferences;
    const preferences = {
      ...previous,
      digestCount: n,
    };
    await db()
      .update(subscribers)
      .set({ preferences })
      .where(eq(subscribers.wecomUserid, msg.fromUserName));
    await sendWeComText(
      msg.fromUserName,
      `${DIGEST_COUNT_REPLY_PREFIX}${n}${DIGEST_COUNT_REPLY_SUFFIX}`,
    );
  } catch (err) {
    console.error('handleDigestCount failed:', err);
    try {
      await sendWeComText(msg.fromUserName, DIGEST_COUNT_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('digestCount fallback reply failed:', fallbackErr);
    }
  }
}

// ---------------------------------------------------------------------------
// handlePushTime / handlePushInterval（Task 5：推送时间与间隔自定义）
// ---------------------------------------------------------------------------

/** 时间 token 字符集（与 router 分发正则同步；阿拉伯 + 中文数字）。 */
const CLOCK_TOKEN_PATTERN = '[0-9一二三四五六七八九十两]+';

/**
 * 「每天 H 点」/「推送时间 HH:MM」解析正则（与 router 的 PUSH_TIME_PATTERN
 * 同形；handler 再校验一次，非法 → 用法提示，不写库）。
 * 组：1=前缀，2=小时 token，3=分钟 token（可缺省 → 00 分）。
 */
const PUSH_TIME_RE = new RegExp(
  `^(每天|推送时间)(?:\\s*(${CLOCK_TOKEN_PATTERN})(?:\\s*[:：点时]\\s*(${CLOCK_TOKEN_PATTERN})?)?\\s*分?)?\\s*$`,
);

/** 「每 N 天(推送|简报)?」解析正则（与 router 的 PUSH_INTERVAL_PATTERN 同步）。 */
const PUSH_INTERVAL_RE = new RegExp(
  `^每\\s*(${CLOCK_TOKEN_PATTERN})\\s*天(推送|简报)?$`,
);

/**
 * 解析钟点/分钟 token：阿拉伯数字（含 0）按值判定 0..max；
 * 中文数字走 parseCnNumber（一..二十/两，下限 1 —— 中文本就没有「零点」写法）。
 * 无法识别/越界 → null（调用方回用法提示）。
 */
function parseClockToken(token: string, max: number): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number.parseInt(token, 10);
    return value <= max ? value : null;
  }
  return parseCnNumber(token, { max });
}

/** 读-合并-写：只更新指定偏好字段，保留其余（languages/keywords/digestCount/另一时间字段）。 */
async function mergePreferences(
  wecomUserid: string,
  patch: { pushTime?: string; intervalDays?: number },
): Promise<void> {
  const rows = await db()
    .select()
    .from(subscribers)
    .where(eq(subscribers.wecomUserid, wecomUserid));
  const previous = rows[0]?.preferences;
  const preferences = {
    ...(previous ?? { languages: [], keywords: [] }),
    ...patch,
  };
  await db()
    .update(subscribers)
    .set({ preferences })
    .where(eq(subscribers.wecomUserid, wecomUserid));
}

/**
 * 「每天 H 点」/「推送时间 HH:MM」handler（router 按锚定正则分发）：
 * - 解析失败（裸指令/越界/无法识别）→ 用法提示，不写库
 *   （如「推送时间 25:99」：小时 25 越界）
 * - 写 preferences.pushTime（「HH:MM」24 小时制），保留其余偏好
 * - 回执注明「北京时间」；digest.ts 门控按同一时区解释该值
 */
export async function handlePushTime(msg: InboundMessage): Promise<void> {
  try {
    const content = msg.content.trim();
    const match = PUSH_TIME_RE.exec(content);
    const hourToken = match?.[2];
    if (match === null || hourToken === undefined) {
      await sendWeComText(msg.fromUserName, PUSH_TIME_USAGE_REPLY);
      return;
    }
    const hour = parseClockToken(hourToken, 23);
    if (hour === null) {
      await sendWeComText(msg.fromUserName, PUSH_TIME_USAGE_REPLY);
      return;
    }
    const minuteToken = match[3];
    let minute = 0;
    if (minuteToken !== undefined) {
      const parsedMinute = parseClockToken(minuteToken, 59);
      if (parsedMinute === null) {
        await sendWeComText(msg.fromUserName, PUSH_TIME_USAGE_REPLY);
        return;
      }
      minute = parsedMinute;
    }
    const pushTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    await mergePreferences(msg.fromUserName, { pushTime });
    await sendWeComText(
      msg.fromUserName,
      `${PUSH_TIME_REPLY_PREFIX}${pushTime}${PUSH_TIME_REPLY_SUFFIX}`,
    );
  } catch (err) {
    console.error('handlePushTime failed:', err);
    try {
      await sendWeComText(msg.fromUserName, PUSH_TIME_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('pushTime fallback reply failed:', fallbackErr);
    }
  }
}

/**
 * 「每 N 天(推送|简报)?」handler（router 按锚定正则分发）：
 * - N 阿拉伯或中文数字（每两天=2），必须 1–30；越界/无法识别 → 用法提示，不写库
 * - 写 preferences.intervalDays，保留其余偏好
 * - digest.ts 抢占 SQL 按该间隔限制重复推送（未满间隔 skipped）
 */
export async function handlePushInterval(msg: InboundMessage): Promise<void> {
  try {
    const content = msg.content.trim();
    const match = PUSH_INTERVAL_RE.exec(content);
    const n =
      match?.[1] === undefined
        ? null
        : parseCnNumber(match[1], { max: MAX_INTERVAL_DAYS });
    if (n === null) {
      await sendWeComText(msg.fromUserName, INTERVAL_USAGE_REPLY);
      return;
    }
    await mergePreferences(msg.fromUserName, { intervalDays: n });
    await sendWeComText(
      msg.fromUserName,
      `${INTERVAL_REPLY_PREFIX}${n}${INTERVAL_REPLY_SUFFIX}`,
    );
  } catch (err) {
    console.error('handlePushInterval failed:', err);
    try {
      await sendWeComText(msg.fromUserName, INTERVAL_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('pushInterval fallback reply failed:', fallbackErr);
    }
  }
}
