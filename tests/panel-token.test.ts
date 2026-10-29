import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  env: { TOKEN_ENCRYPT_KEY: 'test-key-for-panel-tokens' },
}));

import { signPanelToken, verifyPanelToken } from '../src/panel/token';

const NOW = new Date('2026-10-29T01:00:00Z');

describe('panel token', () => {
  it('签名后可还原 userid 与版本号', () => {
    const token = signPanelToken('alice', 3, NOW);
    expect(verifyPanelToken(token, NOW)).toEqual({ userid: 'alice', version: 3 });
  });

  it('过期后无效', () => {
    const token = signPanelToken('alice', 3, NOW, 1000);
    expect(verifyPanelToken(token, new Date(NOW.getTime() + 2000))).toBeNull();
  });

  it('篡改 payload 或签名都无效', () => {
    const token = signPanelToken('alice', 3, NOW);
    const [payload, signature] = token.split('.');
    expect(verifyPanelToken(`${payload}x.${signature}`, NOW)).toBeNull();
    expect(verifyPanelToken(`${payload}.${signature}x`, NOW)).toBeNull();
  });

  it('空串/缺段无效', () => {
    expect(verifyPanelToken('', NOW)).toBeNull();
    expect(verifyPanelToken('abc', NOW)).toBeNull();
  });
});
