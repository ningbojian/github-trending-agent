/**
 * 「收藏 N」/「取消收藏 N」的数字解析：中文数字 + 阿拉伯数字。
 * router 与 stars.ts 共用同一实现，保证两条路径的数字语义完全一致。
 * 支持：一..九、十、十一..十九、二十、两（=2）与阿拉伯数字串；
 * 范围 1–25，其余返回 null（由调用方回用法提示，绝不静默掉进搜索）。
 */

/** 中文单字数字 → 值（「两」口语等同「二」）。 */
const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  两: 2,
};

/** 合法序号范围（与收藏链路的语义一致：1 起，至多 25）。 */
const MIN_N = 1;
const MAX_N = 25;

const ARABIC_RE = /^\d+$/;
const CN_RE = /^[一二三四五六七八九十两]+$/;

/** 收藏序号 token 的字符集片段（router 与 stars.ts 的分发/解析正则共用，保证同步）。 */
export const NUMBER_TOKEN_PATTERN = '[0-9一二三四五六七八九十两]+';

/**
 * 解析序号：成功返回 1–25 的整数，无法识别/越界返回 null。
 * - 阿拉伯数字串：'1'..'25' 合法；'0'/'26'/'' → null
 * - 中文：一..九、十、十一..十九、二十、两；其余（三十/二十一/百…）→ null
 */
export function parseCnNumber(input: string): number | null {
  const token = input.trim();
  if (token.length === 0) {
    return null;
  }

  let value: number | null = null;
  if (ARABIC_RE.test(token)) {
    value = Number.parseInt(token, 10);
  } else if (CN_RE.test(token)) {
    if (token === '十') {
      value = 10;
    } else if (token === '二十') {
      value = 20;
    } else if (token.startsWith('十')) {
      // 十一..十九：第二字必须是个位数字（含「两」= 2 的口语写法）。
      const digit = token.length === 2 ? CN_DIGITS[token[1] as string] : undefined;
      value = digit === undefined ? null : 10 + digit;
    } else if (token.length === 1) {
      value = CN_DIGITS[token] ?? null;
    }
  }

  if (value === null || value < MIN_N || value > MAX_N) {
    return null;
  }
  return value;
}
