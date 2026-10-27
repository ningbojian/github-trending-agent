import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';
import {
  buildSuggestionFact,
  clearPending,
  setPending,
  suggestionText,
  type Confirmation,
  type PendingProfileSuggestion,
} from '../agent/pending.js';
import { readProfile, rememberFact } from '../agent/profile.js';
import { handleSubscribe } from './onboarding.js';

/**
 * 多轮状态的用户侧出口：系统问过「要我记住吗」，用户回「对 / 不」。
 *
 * 先清 pending 再执行：即使写记忆失败，也不能让同一条待办被反复消费——
 * 同一个「对」被处理两次，等于悄悄写入两条状态，这是最难排查的一类 bug。
 */

export const PENDING_REJECT_REPLY = '好的，不记了。想记的时候发「记住 <你的情况>」。';

export const ASK_SUBSCRIBE_KEYWORD_REPLY =
  '想订阅什么？直接回一个词就行（比如 python、react）；多个词用逗号分隔，发「帮助」看全部指令。';

export const SUBSCRIBE_PENDING_FAILED_REPLY =
  '订阅没设上，请直接发「订阅 <词>」（例如「订阅 python」）。';

/** 裸「订阅」→ 追问一个槽。写不进待办就请用户一次发完，不假装在等回复。 */
export async function askSubscribeKeyword(msg: InboundMessage): Promise<void> {
  const stored = await setPending(msg.fromUserName, {
    kind: 'subscribe-keyword',
    at: new Date().toISOString(),
  });
  await sendWeComText(
    msg.fromUserName,
    stored ? ASK_SUBSCRIBE_KEYWORD_REPLY : SUBSCRIBE_PENDING_FAILED_REPLY,
  );
}

/**
 * 用户补上的关键词：直接复用订阅处理器，而不是在这里再写一遍写库与回执。
 * 先清待办——即使订阅失败，也不能让同一个词在下次消息里被重复消费。
 */
export async function handleKeywordReply(
  msg: InboundMessage,
  term: string,
): Promise<void> {
  await clearPending(msg.fromUserName);
  await handleSubscribe({ ...msg, content: `订阅 ${term}` });
}

export async function handlePendingReply(
  msg: InboundMessage,
  pending: PendingProfileSuggestion,
  verdict: Confirmation,
): Promise<void> {
  await clearPending(msg.fromUserName);

  if (verdict === 'reject') {
    await sendWeComText(msg.fromUserName, PENDING_REJECT_REPLY);
    return;
  }

  const status = await rememberFact(msg.fromUserName, pending.fact, new Date());
  if (status === 'added') {
    await sendWeComText(msg.fromUserName, `✅ 记住了：${pending.fact}`);
    return;
  }
  if (status === 'duplicate') {
    await sendWeComText(msg.fromUserName, `这条记忆里已经有了：${pending.fact}`);
    return;
  }
  if (status === 'full') {
    await sendWeComText(
      msg.fromUserName,
      '记忆满了（最多 20 条）。可以先发「忘掉 <关键词>」删一条，再回「对」。',
    );
    return;
  }
  await sendWeComText(msg.fromUserName, '⚠️ 没记住，请稍后再试。');
}

/**
 * 每周复盘后的一条建议：把「多推/少推」翻译成用户能确认的一句话。
 *
 * 只在有净正/净负信号时出现；已经在记忆里的不再问；发送成功之后才落 pending，
 * 避免用户没看见提示、之后随手一个「对」被当成确认。
 */
export async function suggestProfileFromWeek(
  wecomUserid: string,
  stats: { more: string[]; less: string[] },
  now: Date = new Date(),
): Promise<void> {
  const fact = buildSuggestionFact(stats);
  if (fact === '') return;

  const profile = await readProfile(wecomUserid, now);
  const alreadyKnown = (profile?.facts ?? []).some(
    (entry) => entry.toLowerCase() === fact.toLowerCase(),
  );
  if (alreadyKnown) return;

  await sendWeComText(wecomUserid, suggestionText(fact));
  await setPending(
    wecomUserid,
    { kind: 'profile-suggestion', fact, at: now.toISOString() },
    now,
  );
}
