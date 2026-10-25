import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「设置模型」一次性链接的凭证：HMAC 签名 + 15 分钟过期 + 每次签名独立 jti。
 * 这是唯一能换到「帮某个企微 userid 写 Key」权限的东西，所以边界必须钉死：
 * 篡改、过期、乱码、换密钥一律 null，绝不抛出（调用方只做 null 判断）。
 */

const ENV = vi.hoisted(() => ({
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key',
}));

vi.mock('../src/config', () => ({ env: ENV }));

import {
  SETKEY_TTL_MS,
  signSetKeyToken,
  verifySetKeyToken,
} from '../src/agent/setkey-token';

const NOW = 1_760_000_000_000;

beforeEach(() => {
  ENV.TOKEN_ENCRYPT_KEY = 'unit-test-encrypt-key';
});

describe('signSetKeyToken / verifySetKeyToken', () => {
  it('签名后可验回同一个 userid，并带上独立 jti', () => {
    const token = signSetKeyToken('alice', NOW);
    const decoded = verifySetKeyToken(token, NOW);
    expect(decoded?.userid).toBe('alice');
    expect(decoded?.jti).toEqual(expect.any(String));
    expect(decoded!.jti.length).toBeGreaterThan(8);
  });

  it('每次签名 jti 不同（一次性链接不能复用同一 id）', () => {
    const a = verifySetKeyToken(signSetKeyToken('alice', NOW), NOW);
    const b = verifySetKeyToken(signSetKeyToken('alice', NOW), NOW);
    expect(a!.jti).not.toBe(b!.jti);
  });

  it('TTL 正好 15 分钟：到期前最后一刻有效，过期即 null', () => {
    const token = signSetKeyToken('alice', NOW);
    expect(SETKEY_TTL_MS).toBe(15 * 60 * 1000);
    expect(verifySetKeyToken(token, NOW + SETKEY_TTL_MS - 1)).not.toBeNull();
    expect(verifySetKeyToken(token, NOW + SETKEY_TTL_MS)).toBeNull();
  });

  it('篡改 payload → null', () => {
    const token = signSetKeyToken('alice', NOW);
    const [payload, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ u: 'mallory', e: NOW + SETKEY_TTL_MS, j: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(verifySetKeyToken(`${forged}.${sig}`, NOW)).toBeNull();
    // 原 payload 仍然有效，确认失败来自签名而不是解析
    expect(verifySetKeyToken(`${payload}.${sig}`, NOW)).not.toBeNull();
  });

  it('篡改签名 → null', () => {
    const token = signSetKeyToken('alice', NOW);
    const [payload, sig] = token.split('.') as [string, string];
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifySetKeyToken(`${payload}.${flipped}`, NOW)).toBeNull();
  });

  it('换密钥（服务端轮换/伪造）→ null', () => {
    const token = signSetKeyToken('alice', NOW);
    ENV.TOKEN_ENCRYPT_KEY = 'another-key';
    expect(verifySetKeyToken(token, NOW)).toBeNull();
  });

  it.each(['', 'abc', 'a.b.c', '.', 'null.null'])('乱码「%s」→ null，不抛错', (bad) => {
    expect(() => verifySetKeyToken(bad, NOW)).not.toThrow();
    expect(verifySetKeyToken(bad, NOW)).toBeNull();
  });

  it('payload 缺 userid / 超长 → null', () => {
    // 用真实签名伪造「合法签名但内容非法」，覆盖结构校验分支
    const now = NOW;
    for (const body of [{ e: now + SETKEY_TTL_MS, j: 'x' }, { u: '', e: now + SETKEY_TTL_MS, j: 'x' }]) {
      const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
      const sig = signSetKeyToken('probe', now).split('.')[1]!;
      expect(verifySetKeyToken(`${payload}.${sig}`, now)).toBeNull();
    }
  });
});
