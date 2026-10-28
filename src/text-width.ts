/**
 * 终端/聊天客户端的「显示宽度」计算。
 *
 * 企微标题的截断是按像素/列宽发生的：一个汉字或全角标点占 2 列，ASCII 占 1 列。
 * 用字符数做预算会高估英文、低估中文——实测标题在约 20 列之后就被裁掉。
 */

/** 全角/宽字符（CJK、谚文、全角标点、常见 emoji）。 */
export function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

/** 文本的显示列数：汉字/全角算 2，ASCII 算 1。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}
