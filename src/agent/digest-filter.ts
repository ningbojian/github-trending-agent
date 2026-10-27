import { pushedRecently, type PushHistory } from './push-history.js';
import { normalizeRepoName } from './repo-name.js';
import type { DigestCandidate, UserSignals } from './taste.js';

/**
 * 硬过滤：什么样的条目今天**不该**出现。
 *
 * 三条都是「用户已经知道 / 明确说过不要」的，不做任何猜测。
 * 增长门槛单独放在 passesGrowth，因为它也用在退化路径的 accept 谓词里。
 */

/** 7 天窗口内至少涨 100 星才算「明显增长」。日常热榜增量多在 20–500。 */
export const GROWTH_MIN_DELTA = 100;

export interface Growable {
  fullName: string;
  starsDelta: number;
  isNew: boolean;
}

/** 新上过榜的不看增量；老面孔要涨够门槛。 */
export function passesGrowth(item: Growable): boolean {
  return item.isNew || item.starsDelta >= GROWTH_MIN_DELTA;
}

export function applyHardFilters<T extends DigestCandidate & Growable>(
  items: T[],
  opts: { signals: UserSignals; history: PushHistory | null; now: Date },
): T[] {
  const { signals, history, now } = opts;
  return items.filter((item) => {
    if (signals.starred.has(normalizeRepoName(item.fullName))) return false;
    if (pushedRecently(history, item.fullName, now)) return false;
    const language = (item.language ?? '').trim().toLowerCase();
    if (language !== '' && signals.suppressed.has(language)) return false;
    return true;
  });
}
