import { describe, expect, it } from 'vitest';
import { classifyByRules } from '../src/agent/intent';

/**
 * 意图边界规则：只拦高置信的明显无关输入。
 * 最重要的不变量是**漏判退化成搜索**——凡是像正常提问的，都必须返回 null。
 */
describe('classifyByRules — about（产品介绍）', () => {
  it.each([
    '你是谁',
    '你是什么',
    '你是谁？',
    '你叫什么',
    '你能做什么',
    '你能干什么',
    '你能干嘛',
    '你会做什么',
    '你可以做什么',
    '你有什么功能',
    '你有哪些功能',
    '介绍一下你',
    '介绍下你自己',
    '你是机器人吗',
  ])('「%s」→ about', (text) => {
    expect(classifyByRules(text)).toBe('about');
  });

  it('关于本产品的正常提问不算 about（交给搜索）', () => {
    expect(classifyByRules('本周 python 的 ai 项目')).toBeNull();
  });
});

describe('classifyByRules — off_topic（明显无关）', () => {
  it.each([
    '今天天气怎么样',
    '明天会下雨吗',
    '现在气温多少',
    '帮我看看股票',
    '美元汇率多少',
    '翻译成英文',
    '讲个笑话',
    '写首诗',
    '现在几点了',
  ])('「%s」→ off_topic', (text) => {
    expect(classifyByRules(text)).toBe('off_topic');
  });
});

describe('classifyByRules — 不误伤正常提问', () => {
  it.each([
    '看看热榜',
    '今天有什么',
    '今天有什么好项目',
    '本周 rust 的 ai 项目',
    '推荐一个天气数据可视化项目', // 命中「天气」但带领域词
    '最近增长最快的开源项目',
    'star 超过 1 万的翻译工具项目',
    '有没有帮助学习的 python 库',
    '介绍下你用过的 python 库', // 整句不是「介绍一下你自己」
  ])('「%s」→ null（照常搜索）', (text) => {
    expect(classifyByRules(text)).toBeNull();
  });

  it('过长的句子不用规则判定（交给 LLM），避免长句搜索被误伤', () => {
    const long = '我想找一个最近一周 star 涨得特别快、用 rust 写的、带完整文档和示例的天气数据处理项目';
    expect(long.length).toBeGreaterThan(30);
    expect(classifyByRules(long)).toBeNull();
  });

  it('空串与纯标点 → null', () => {
    expect(classifyByRules('')).toBeNull();
    expect(classifyByRules('   ')).toBeNull();
    expect(classifyByRules('。。。')).toBeNull();
  });
});
