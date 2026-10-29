import { resolveBaseUrl } from '../email/tokens.js';
import { signPanelToken } from '../panel/token.js';
import { getPanelVersion } from '../panel/version.js';
import { sendWeComText } from './api.js';
import type { InboundMessage } from './router.js';

/**
 * 「我的面板」：发一条 7 天有效的签名链接。
 *
 * 面板不是每日入口；只在用户主动要、或跟踪变化摘要末尾按需给链接。
 * 链接里只有 userid 与版本号（HMAC 签名），不暴露任何凭证。
 */

export const PANEL_UNAVAILABLE_REPLY = '面板链接暂时不可用，请稍后再试。';

export async function handleMyPanel(msg: InboundMessage): Promise<void> {
  try {
    const base = resolveBaseUrl();
    // 本地/测试环境没有公网域名：不发点不开的 localhost 链接。
    if (/localhost|127\.0\.0\.1/.test(base)) {
      await sendWeComText(msg.fromUserName, PANEL_UNAVAILABLE_REPLY);
      return;
    }
    const version = await getPanelVersion(msg.fromUserName);
    const token = signPanelToken(msg.fromUserName, version);
    await sendWeComText(
      msg.fromUserName,
      [
        '🔗 你的控制面板（7 天有效）：',
        `${base}/api/panel?t=${encodeURIComponent(token)}`,
        '可以管理跟踪、看历史简报、收藏与订阅设置；随时发「我的面板」可重新获取。',
      ].join('\n'),
    );
  } catch (err) {
    console.error('handleMyPanel failed:', err);
    await sendWeComText(msg.fromUserName, PANEL_UNAVAILABLE_REPLY);
  }
}
