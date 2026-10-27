import {
  PROFILE_MAX_FACTS,
  forgetAll,
  forgetFacts,
  readProfile,
  rememberFact,
} from '../agent/profile.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「记住 / 忘掉 / 我的记忆」三条指令的解析与回执。
 *
 * 记忆本身不花模型额度：写入是 kv，查看是读 kv，没配 Key 的用户同样可用。
 * 回执必须说真话——存储失败就说没记住，而不是先「✅」再悄悄丢掉。
 */

export type MemoryCommand =
  | { kind: 'remember'; fact: string }
  | { kind: 'forget'; term: string | null }
  | { kind: 'show' };

const FORGET_ALL_WORDS = new Set(['全部', '所有', '全都', '一切']);

/** 纯解析；不是记忆指令返回 null。前缀即命令（「记住这个仓库…」也算记住）。 */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const trimmed = text.trim();
  if (trimmed === '我的记忆') {
    return { kind: 'show' };
  }
  if (trimmed.startsWith('记住')) {
    return { kind: 'remember', fact: trimmed.slice('记住'.length).trim() };
  }
  if (trimmed.startsWith('忘掉')) {
    const rest = trimmed.slice('忘掉'.length).trim();
    if (rest === '' || FORGET_ALL_WORDS.has(rest)) {
      return { kind: 'forget', term: null };
    }
    return { kind: 'forget', term: rest };
  }
  return null;
}

export const MEMORY_ERROR_REPLY = '⚠️ 暂时读不到记忆，请稍后再试。';
export const MEMORY_USAGE_REPLY = '用法：回复「我的记忆」查看，或「记住 <你的情况>」。';

const REMEMBER_USAGE_REPLY = '要记住什么？例如：记住 我主要做 Agent 开发';

const SHOW_EMPTY_REPLY =
  '你还没有记忆。发「记住 <你的情况>」即可，比如「记住 我主要做 Agent 开发」。';

function showReply(facts: string[]): string {
  if (facts.length === 0) {
    return SHOW_EMPTY_REPLY;
  }
  const lines = facts.map((fact, index) => `${index + 1}. ${fact}`);
  return [
    `🧠 我的记忆（${facts.length} 条）`,
    ...lines,
    '',
    '💡 「忘掉 <关键词>」删除单条；「忘掉 全部」清空。',
  ].join('\n');
}

export async function handleMemoryCommand(msg: InboundMessage): Promise<void> {
  const command = parseMemoryCommand(msg.content);
  if (command === null) {
    await sendWeComText(msg.fromUserName, MEMORY_USAGE_REPLY);
    return;
  }

  if (command.kind === 'show') {
    const profile = await readProfile(msg.fromUserName);
    await sendWeComText(msg.fromUserName, showReply(profile?.facts ?? []));
    return;
  }

  if (command.kind === 'remember') {
    if (command.fact === '') {
      await sendWeComText(msg.fromUserName, REMEMBER_USAGE_REPLY);
      return;
    }
    const status = await rememberFact(msg.fromUserName, command.fact);
    if (status === 'added') {
      await sendWeComText(msg.fromUserName, `✅ 记住了：${command.fact}`);
      return;
    }
    if (status === 'duplicate') {
      await sendWeComText(
        msg.fromUserName,
        `这条记忆里已经有了：${command.fact}（发「我的记忆」查看全部）`,
      );
      return;
    }
    if (status === 'full') {
      await sendWeComText(
        msg.fromUserName,
        `记忆满了（最多 ${PROFILE_MAX_FACTS} 条）。发「我的记忆」看看，先「忘掉 <关键词>」腾出位置。`,
      );
      return;
    }
    await sendWeComText(msg.fromUserName, MEMORY_ERROR_REPLY);
    return;
  }

  // forget
  if (command.term === null) {
    const ok = await forgetAll(msg.fromUserName);
    await sendWeComText(msg.fromUserName, ok ? '🧹 记忆已清空。' : MEMORY_ERROR_REPLY);
    return;
  }
  const removed = await forgetFacts(msg.fromUserName, command.term);
  if (removed.length === 0) {
    await sendWeComText(
      msg.fromUserName,
      `没找到包含「${command.term}」的记忆。发「我的记忆」看看有哪些。`,
    );
    return;
  }
  await sendWeComText(msg.fromUserName, `✅ 忘掉了：${removed.join('；')}`);
}
