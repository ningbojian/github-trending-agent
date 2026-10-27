import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_USAGE_REPLY,
  MAX_FEEDBACK_TARGETS,
  parseFeedbackCommand,
} from '../src/wecom/feedback-target';

/**
 * 「不感兴趣 3」这类精确反馈的解析。
 *
 * 纯函数：只决定「这条消息想作用在哪些仓库上」，不碰 DB、不发消息。
 * 返回 null 表示「这压根不是口味指令」——调用方要把它当普通搜索处理。
 */
describe('parseFeedbackCommand', () => {
  it('裸词 → 作用于整批', () => {
    expect(parseFeedbackCommand('感兴趣')).toEqual({
      verb: '感兴趣',
      target: { kind: 'batch' },
    });
    expect(parseFeedbackCommand('不感兴趣')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'batch' },
    });
  });

  it('尾标点不影响判定（router 剥一次，这里再兜一次）', () => {
    expect(parseFeedbackCommand('不感兴趣。')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'batch' },
    });
  });

  it('序号：阿拉伯、逗号分隔、中文数字都支持', () => {
    expect(parseFeedbackCommand('不感兴趣 3')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'numbers', numbers: [3] },
    });
    expect(parseFeedbackCommand('不感兴趣 3,5')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'numbers', numbers: [3, 5] },
    });
    expect(parseFeedbackCommand('感兴趣 三、五')).toEqual({
      verb: '感兴趣',
      target: { kind: 'numbers', numbers: [3, 5] },
    });
  });

  it('重复序号只算一次', () => {
    expect(parseFeedbackCommand('不感兴趣 3,3 三')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'numbers', numbers: [3] },
    });
  });

  it('仓库名：保留原大小写，重复（大小写不同）只算一次', () => {
    expect(parseFeedbackCommand('不感兴趣 Owner/Repo')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'repos', repos: ['Owner/Repo'] },
    });
    expect(parseFeedbackCommand('不感兴趣 owner/repo owner/REPO')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'repos', repos: ['owner/repo'] },
    });
    expect(parseFeedbackCommand('感兴趣 a/b c/d')).toEqual({
      verb: '感兴趣',
      target: { kind: 'repos', repos: ['a/b', 'c/d'] },
    });
  });

  it('序号和仓库名混用 → invalid（不猜用户想改哪一条）', () => {
    expect(parseFeedbackCommand('不感兴趣 3 owner/repo')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'invalid', reason: 'mixed' },
    });
  });

  it('序号越界/非数字 → invalid', () => {
    expect(parseFeedbackCommand('不感兴趣 0')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'invalid', reason: 'bad-token' },
    });
    expect(parseFeedbackCommand('不感兴趣 26')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'invalid', reason: 'bad-token' },
    });
    expect(parseFeedbackCommand('不感兴趣 abc')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'invalid', reason: 'bad-token' },
    });
    expect(parseFeedbackCommand('不感兴趣 owner/repo/extra')).toEqual({
      verb: '不感兴趣',
      target: { kind: 'invalid', reason: 'bad-token' },
    });
  });

  it(`最多 ${MAX_FEEDBACK_TARGETS} 个目标`, () => {
    const many = Array.from({ length: MAX_FEEDBACK_TARGETS + 1 }, (_, i) => `a/b${i}`).join(' ');
    expect(parseFeedbackCommand(`不感兴趣 ${many}`)).toEqual({
      verb: '不感兴趣',
      target: { kind: 'invalid', reason: 'too-many' },
    });
  });

  it('动词后没有空白 → 不是指令（「感兴趣owner/repo」仍走搜索）', () => {
    expect(parseFeedbackCommand('感兴趣owner/repo')).toBeNull();
    expect(parseFeedbackCommand('不感兴趣3')).toBeNull();
  });

  it('无关文本 → null', () => {
    expect(parseFeedbackCommand('兴趣')).toBeNull();
    expect(parseFeedbackCommand('python 热榜')).toBeNull();
    expect(parseFeedbackCommand('')).toBeNull();
  });

  it('用法提示提到三种写法', () => {
    expect(FEEDBACK_USAGE_REPLY).toContain('不感兴趣 3');
    expect(FEEDBACK_USAGE_REPLY).toContain('owner/repo');
  });
});
