import { describe, expect, it } from 'vitest';
import { parseCnNumber } from '../src/wecom/cn-number';

/**
 * Task 4：「收藏 N」的数字解析（中文数字 + 阿拉伯数字）。
 * 支持：一..九、十、十一..十九、二十、两（=2）与阿拉伯数字串；
 * 范围 1–25，其余返回 null（由调用方回用法提示，绝不静默）。
 */
describe('parseCnNumber — 中文数字与阿拉伯数字解析', () => {
  it('单字中文数字 一..九 → 1..9', () => {
    expect(parseCnNumber('一')).toBe(1);
    expect(parseCnNumber('二')).toBe(2);
    expect(parseCnNumber('三')).toBe(3);
    expect(parseCnNumber('九')).toBe(9);
  });

  it('「十」= 10；十一..十九 → 11..19', () => {
    expect(parseCnNumber('十')).toBe(10);
    expect(parseCnNumber('十一')).toBe(11);
    expect(parseCnNumber('十五')).toBe(15);
    expect(parseCnNumber('十九')).toBe(19);
  });

  it('「二十」= 20；「两」= 2', () => {
    expect(parseCnNumber('二十')).toBe(20);
    expect(parseCnNumber('两')).toBe(2);
  });

  it('阿拉伯数字串 1..25 → 对应整数', () => {
    expect(parseCnNumber('1')).toBe(1);
    expect(parseCnNumber('10')).toBe(10);
    expect(parseCnNumber('25')).toBe(25);
  });

  it('越界与非法输入 → null（0、26、空串、非数字、未支持的中文数字）', () => {
    expect(parseCnNumber('0')).toBeNull();
    expect(parseCnNumber('26')).toBeNull();
    expect(parseCnNumber('99')).toBeNull();
    expect(parseCnNumber('')).toBeNull();
    expect(parseCnNumber('abc')).toBeNull();
    expect(parseCnNumber('第')).toBeNull();
    expect(parseCnNumber('三十')).toBeNull();
    expect(parseCnNumber('二十一')).toBeNull();
    expect(parseCnNumber('百')).toBeNull();
  });

  it('首尾空白容忍（trim 后解析）', () => {
    expect(parseCnNumber(' 1 ')).toBe(1);
    expect(parseCnNumber(' 两')).toBe(2);
  });
});
