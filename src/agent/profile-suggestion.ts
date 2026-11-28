import { sendWeComText } from '../shared/wecom-api.js';
import {
  buildSuggestionFact,
  setPending,
  suggestionText,
} from './pending.js';
import { readProfile } from './profile.js';

/**
 * 每周复盘后的一条建议：把「多推/少推」翻译成用户能确认的一句话。
 *
 * 放在 agent 层：它读画像、写 pending、发消息，全是业务编排；
 * 唯一调用方 `weekly-review.ts` 也在 agent 层。此前放在 wecom/pending.ts
 * 导致 agent → wecom 依赖环，迁到这里后环消失。
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
