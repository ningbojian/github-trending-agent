import { parseTrackRequest } from '../agent/tracking.js';
import { parseCnNumber } from './cn-number.js';
import {
  addTrackedRepo,
  listTracked,
  removeTracked,
  writeTrackList,
} from '../agent/tracking-service.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「追踪 / 我的追踪 / 取消追踪」命令。
 *
 * 与 GitHub Watch 的差异：这里只登记「要关注什么」，真正的变化判定
 * 在每日检查里做（新 release / star 加速 / 归档），且第一次检查只建基线。
 * 落库逻辑在 tracking-service（面板也共用）。
 */

export const TRACK_USAGE_REPLY =
  '用法：「追踪 owner/repo」或「追踪 https://github.com/owner/repo」，例如：追踪 astral-sh/ruff';
export const TRACK_LIMIT_REPLY =
  '最多同时跟踪 10 个仓库；先发「我的追踪」取消一个。';
export const TRACK_FAILURE_REPLY = '暂时读不到这个仓库，稍后再试。';
export const UNTRACK_USAGE_REPLY =
  '用法：「取消追踪 2」按序号取消，或「取消追踪 owner/repo」。';
export const MY_TRACKING_EMPTY_REPLY =
  '你还没有跟踪任何仓库。发「追踪 owner/repo」试试，例如：追踪 astral-sh/ruff';

function trackArg(content: string): string {
  return content.trim().replace(/^(追踪|跟踪|关注)\s*/, '').trim();
}

function untrackArg(content: string): string {
  return content.trim().replace(/^取消(追踪|跟踪|关注)\s*/, '').trim();
}

/** 「追踪 <GitHub 仓库>」：校验仓库、用当前状态建基线、落库。 */
export async function handleTrack(msg: InboundMessage): Promise<void> {
  const result = await addTrackedRepo(msg.fromUserName, trackArg(msg.content));
  if (result.ok) {
    await sendWeComText(
      msg.fromUserName,
      `✅ 已跟踪 ${result.displayName}（当前 ★${result.stars}）。有新 release 或 star 加速时，我会在每天的「跟踪变化」里告诉你。`,
    );
    return;
  }

  if (result.reason === 'usage') {
    await sendWeComText(msg.fromUserName, TRACK_USAGE_REPLY);
  } else if (result.reason === 'limit') {
    await sendWeComText(msg.fromUserName, TRACK_LIMIT_REPLY);
  } else {
    await sendWeComText(msg.fromUserName, TRACK_FAILURE_REPLY);
  }
}

/** 「我的追踪」：列出编号，并缓存列表供按序号取消。 */
export async function handleMyTracking(msg: InboundMessage): Promise<void> {
  try {
    const rows = await listTracked(msg.fromUserName);
    if (rows.length === 0) {
      await sendWeComText(msg.fromUserName, MY_TRACKING_EMPTY_REPLY);
      return;
    }

    await writeTrackList(msg.fromUserName, rows);
    const lines = rows.map((row, index) => `${index + 1}. ${row.displayName}`);
    await sendWeComText(
      msg.fromUserName,
      ['你正在跟踪：', ...lines, '发「取消追踪 N」取消第 N 个。'].join('\n'),
    );
  } catch (err) {
    console.error('handleMyTracking failed:', err);
    await sendWeComText(msg.fromUserName, '读取跟踪列表失败，请稍后再试。');
  }
}

/** 「取消追踪 N / owner/repo」：置 active=false。 */
export async function handleUntrack(msg: InboundMessage): Promise<void> {
  const arg = untrackArg(msg.content);
  if (arg === '') {
    await sendWeComText(msg.fromUserName, UNTRACK_USAGE_REPLY);
    return;
  }

  try {
    let identifier: string | null = null;
    let displayName: string | null = null;

    const index = parseCnNumber(arg, { max: 10 });
    if (index !== null) {
      // 直接查库，不依赖先发「我的追踪」写缓存；列表顺序与面板一致。
      const rows = await listTracked(msg.fromUserName);
      const item = rows[index - 1];
      if (!item) {
        await sendWeComText(msg.fromUserName, UNTRACK_USAGE_REPLY);
        return;
      }
      identifier = item.identifier;
      displayName = item.displayName;
    } else {
      const target = parseTrackRequest(arg);
      if (target === null) {
        await sendWeComText(msg.fromUserName, UNTRACK_USAGE_REPLY);
        return;
      }
      identifier = target.identifier;
      displayName = target.displayName;
    }

    await removeTracked(msg.fromUserName, identifier);
    await sendWeComText(msg.fromUserName, `✅ 已取消跟踪 ${displayName}。`);
  } catch (err) {
    console.error('handleUntrack failed:', err);
    await sendWeComText(msg.fromUserName, '取消跟踪失败，请稍后再试。');
  }
}
