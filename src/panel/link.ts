import { productionBaseUrl } from '../http/base-url.js';
import { signPanelToken } from './token.js';
import { getPanelVersion } from './version.js';

/**
 * 生成某个用户的面板链接（7 天有效）。
 * 供「我的面板」命令与「今日观察」卡片点击跳转共用。
 */
export async function buildPanelUrl(
  userid: string,
  baseUrl: string = productionBaseUrl() ?? '',
): Promise<string | null> {
  const base = baseUrl.replace(/\/+$/, '');
  if (base === '') return null;
  const version = await getPanelVersion(userid);
  const token = signPanelToken(userid, version);
  return `${base}/api/panel?t=${encodeURIComponent(token)}`;
}
