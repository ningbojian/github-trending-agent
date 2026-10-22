import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * 企业微信回调消息加解密（官方 WXBizMsgCrypt 方案）：
 * - AESKey = Base64Decode(EncodingAESKey + "=")，32 字节
 * - AES-256-CBC，IV 取 AESKey 前 16 字节，PKCS#7 块长 32（非标准 16）
 * - 明文布局：random(16) + msg_len(4, network order) + msg + receiveid
 * - msg_signature = sha1(sort(token, timestamp, nonce, encrypt).join(""))
 */

/** PKCS#7 块长：企业微信用 32 而非 OpenSSL 默认 16。 */
const PKCS7_BLOCK_SIZE = 32;

function pkcs7Pad(data: Buffer): Buffer {
  const padLen = PKCS7_BLOCK_SIZE - (data.length % PKCS7_BLOCK_SIZE);
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}

function pkcs7Unpad(data: Buffer): Buffer {
  // 合法 PKCS#7 密文长度必为块长整数倍；先断言再读尾字节，防畸形输入
  if (data.length % PKCS7_BLOCK_SIZE !== 0) {
    throw new Error('WxbizMsgCrypt: invalid PKCS#7 padding');
  }
  const padLen = data.length > 0 ? data[data.length - 1] : 0;
  if (padLen < 1 || padLen > PKCS7_BLOCK_SIZE || padLen > data.length) {
    throw new Error('WxbizMsgCrypt: invalid PKCS#7 padding');
  }
  for (let i = 0; i < padLen; i++) {
    if (data[data.length - 1 - i] !== padLen) {
      throw new Error('WxbizMsgCrypt: invalid PKCS#7 padding');
    }
  }
  return data.subarray(0, data.length - padLen);
}

/** 常量时间比较两个 hex 签名。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export class WxbizMsgCrypt {
  private readonly token: string;
  private readonly aesKey: Buffer;
  private readonly corpId: string;

  constructor(token: string, aesKey: string, corpId: string) {
    this.token = token;
    this.aesKey = Buffer.from(`${aesKey}=`, 'base64');
    if (this.aesKey.length !== 32) {
      throw new Error(
        'WxbizMsgCrypt: EncodingAESKey must decode to 32 bytes',
      );
    }
    this.corpId = corpId;
  }

  /** sha1(sort(token, timestamp, nonce, encrypt).join("")) */
  private signature(timestamp: string, nonce: string, encrypt: string): string {
    return createHash('sha1')
      .update([this.token, timestamp, nonce, encrypt].sort().join(''))
      .digest('hex');
  }

  private verifySignature(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encrypt: string,
  ): void {
    const expected = this.signature(timestamp, nonce, encrypt);
    if (!safeEqualHex(expected, msgSignature.toLowerCase())) {
      throw new Error('WxbizMsgCrypt: signature verification failed');
    }
  }

  private decrypt(encryptMsg: string): string {
    const ciphertext = Buffer.from(encryptMsg, 'base64');
    const decipher = createDecipheriv(
      'aes-256-cbc',
      this.aesKey,
      this.aesKey.subarray(0, 16),
    );
    decipher.setAutoPadding(false);
    const plain = pkcs7Unpad(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    );
    // random(16) + len(4) + msg + receiveid
    if (plain.length < 20) {
      throw new Error('WxbizMsgCrypt: decrypted payload too short');
    }
    const msgLen = plain.readUInt32BE(16);
    if (20 + msgLen > plain.length) {
      throw new Error('WxbizMsgCrypt: msg length out of range');
    }
    const receiveId = plain.subarray(20 + msgLen).toString('utf8');
    if (receiveId !== this.corpId) {
      throw new Error('WxbizMsgCrypt: receiveid mismatch');
    }
    return plain.subarray(20, 20 + msgLen).toString('utf8');
  }

  /**
   * GET URL 验证：校验 echostr 签名并解密，返回明文（需原样回传）。
   */
  verifyUrl(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    echostr: string,
  ): string {
    this.verifySignature(msgSignature, timestamp, nonce, echostr);
    return this.decrypt(echostr);
  }

  /**
   * POST 消息解密：校验签名并解密，校验 receiveid。
   */
  decryptMsg(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encryptMsg: string,
  ): string {
    this.verifySignature(msgSignature, timestamp, nonce, encryptMsg);
    return this.decrypt(encryptMsg);
  }

  /**
   * 加密明文（主动构造报文时用，如联调）。
   * 返回值含 timestamp —— 签名与时间戳绑定，调用方回传报文时需要它。
   */
  encrypt(text: string): {
    encrypt: string;
    msgSignature: string;
    nonce: string;
    timestamp: string;
  } {
    const msg = Buffer.from(text, 'utf8');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(8).toString('hex');
    const random = randomBytes(16);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msg.length, 0);
    const plain = pkcs7Pad(
      Buffer.concat([random, lenBuf, msg, Buffer.from(this.corpId, 'utf8')]),
    );
    const cipher = createCipheriv(
      'aes-256-cbc',
      this.aesKey,
      this.aesKey.subarray(0, 16),
    );
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([
      cipher.update(plain),
      cipher.final(),
    ]).toString('base64');
    return {
      encrypt: ciphertext,
      msgSignature: this.signature(timestamp, nonce, ciphertext),
      nonce,
      timestamp,
    };
  }
}
