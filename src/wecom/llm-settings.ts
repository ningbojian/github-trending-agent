import { signSetKeyToken } from '../agent/setkey-token.js';
import { clearUserLlm, describeUserLlm, loadUserLlm } from '../agent/user-llm.js';
import { env } from '../config.js';
import { resolveBaseUrl } from '../email/tokens.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 用户自备 AI Key 的三个会话命令（router 精确匹配后分发）：
 * - 「设置模型」→ 回一条 15 分钟有效、只能用一次的网页链接（Key 绝不走微信）
 * - 「我的模型」→ 回当前配置（Key 只露掩码）
 * - 「清除模型」→ 删三列，互动回到零消耗的规则模式
 *
 * 为什么不直接在微信里收 Key：消息会经企微服务器留痕，聊天记录里长期可见；
 * 网页表单只在 HTTPS 请求体里出现一次，落库前即加密（crypto/secret.ts）。
 */

/** 微信里发「设置模型」拿到的链接正文（链接单独一行，方便点按）。 */
function setModelReply(link: string): string {
  return [
    '请用浏览器打开下面的链接，填你自己的 AI Key（15 分钟内有效，只能用一次）：',
    link,
    '配好后互动用你自己的额度；不配置也能用，只是不会有中文简介。',
  ].join('\n');
}

/** 没配加密密钥时无法签发链接（也没法落库），明确说不能保存。 */
export const SET_MODEL_FAILURE_REPLY =
  '服务未配置加密密钥，暂时无法保存你的 Key。请联系管理员后再试。';

/** 「设置模型」带了多余参数时的用法提示。 */
export const SET_MODEL_USAGE_REPLY = '用法：直接回复「设置模型」即可（无需参数）';

/** 「我的模型」带了多余参数时的用法提示。 */
export const MY_MODEL_USAGE_REPLY = '用法：直接回复「我的模型」即可（无需参数）';

/** 「清除模型」带了多余参数时的用法提示。 */
export const CLEAR_MODEL_USAGE_REPLY = '用法：直接回复「清除模型」即可（无需参数）';

/** 「我的模型」读取失败的兜底文案。 */
export const MY_MODEL_FAILURE_REPLY = '读取模型配置失败，请稍后再试';

/** 「清除模型」成功文案（同时说明退回什么模式）。 */
export const CLEAR_MODEL_REPLY =
  '已清除你自己的模型配置。之后的互动使用规则解析 + 共享缓存简介，不消耗任何模型额度。';

/** 「清除模型」失败文案。 */
export const CLEAR_MODEL_FAILURE_REPLY = '清除失败，请稍后再试';

/**
 * 拼一次性设置链接。
 *
 * TOKEN_ENCRYPT_KEY 缺失时**显式抛错**而不是签出一个「永远验不过」的 token：
 * 签名密钥读不到，链接发出去用户也只会看到「链接无效」，不如直接说不能保存。
 */
export function buildSetKeyLink(wecomUserid: string): string {
  if (!env.TOKEN_ENCRYPT_KEY) {
    throw new Error('TOKEN_ENCRYPT_KEY is not configured');
  }
  const token = signSetKeyToken(wecomUserid);
  return `${resolveBaseUrl()}/api/set-key?t=${encodeURIComponent(token)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 「设置模型」：回一次性链接；签发失败回「服务未配置加密密钥」。 */
export async function handleSetModel(msg: InboundMessage): Promise<void> {
  let text: string;
  try {
    text = setModelReply(buildSetKeyLink(msg.fromUserName));
  } catch (err) {
    // 只记原因（不含任何凭据）。
    console.error('handleSetModel failed:', errorMessage(err));
    text = SET_MODEL_FAILURE_REPLY;
  }
  try {
    await sendWeComText(msg.fromUserName, text);
  } catch (err) {
    console.error('setModel reply failed:', err);
  }
}

/** 「我的模型」：当前配置（接口 / 模型 / 掩码 Key）或「未配置」。 */
export async function handleMyModel(msg: InboundMessage): Promise<void> {
  try {
    const config = await loadUserLlm(msg.fromUserName);
    await sendWeComText(msg.fromUserName, describeUserLlm(config));
  } catch (err) {
    console.error('handleMyModel failed:', err);
    try {
      await sendWeComText(msg.fromUserName, MY_MODEL_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('myModel fallback reply failed:', fallbackErr);
    }
  }
}

/** 「清除模型」：三列置空。 */
export async function handleClearModel(msg: InboundMessage): Promise<void> {
  try {
    await clearUserLlm(msg.fromUserName);
    await sendWeComText(msg.fromUserName, CLEAR_MODEL_REPLY);
  } catch (err) {
    console.error('handleClearModel failed:', err);
    try {
      await sendWeComText(msg.fromUserName, CLEAR_MODEL_FAILURE_REPLY);
    } catch (fallbackErr) {
      // 吞掉兜底发送失败：仅记日志，不重试（防递归）。
      console.error('clearModel fallback reply failed:', fallbackErr);
    }
  }
}
