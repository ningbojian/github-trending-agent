import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config.js';

/**
 * 入库密钥的对称加密（AES-256-GCM，密钥由 TOKEN_ENCRYPT_KEY 派生）。
 *
 * 目前两种密文共用此实现：用户的 GitHub token（subscribers.github_token_enc）
 * 与用户自备的 LLM Key（subscribers.llm_key_enc）。刻意不区分用途——
 * 两者都是「只该服务端读到的凭据」，且都能单向还原；用途分离靠列名与
 * 各自的读取路径，签名类用途（见 agent/setkey-token.ts）才需要域分离密钥。
 */

const ALGO = 'aes-256-gcm';
/** GCM 推荐 IV 长度 12 字节。 */
const IV_BYTES = 12;
/** GCM 认证标签 16 字节。 */
const TAG_BYTES = 16;

/** 密钥派生：sha256(TOKEN_ENCRYPT_KEY)（确定性，32 字节正好喂 aes-256）。 */
function encryptionKey(): Buffer {
  return createHash('sha256').update(env.TOKEN_ENCRYPT_KEY, 'utf8').digest();
}

/**
 * 加密明文。
 * 输出 base64(iv(12) || tag(16) || ciphertext)，每次随机 IV。
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** 解密 encryptSecret 的输出；篡改/畸形输入经 GCM 校验后抛错。 */
export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('decryptSecret: payload too short');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  );
}
