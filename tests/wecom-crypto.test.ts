import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WxbizMsgCrypt } from '../src/wecom/crypto';

/**
 * 测试凭据：企业微信官方文档公开的样例值（非真实密钥）。
 * 注意：官方文档页面在本环境无法访问（网络受限），未能取得官方发布的
 * 密文/签名样例——下方密文 fixture 由独立的一次性参考脚本（固定随机前缀、
 * 与 src/wecom/crypto.ts 无共享代码）生成，签名另行用 sha1sum 独立计算。
 * 与官方线上报文的比对留待 Task 14 真实联调完成。
 */
const TOKEN = 'QDG6eK';
const AES_KEY = 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C';
const CORP_ID = 'wx5823bf96d3bd56c7';

/**
 * 确定性密文 fixture（随机前缀固定为 16 字节 ASCII，故可复现）：
 * plaintext = 官方文档示例明文 XML（this is a test），
 * timestamp = 1409659589, nonce = 1871185774。
 */
const FIXTURE_PLAINTEXT =
  '<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName><FromUserName><![CDATA[mycreate]]></FromUserName><CreateTime>1409659813</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[this is a test]]></Content><MsgId>4561255354251345929</MsgId><AgentID>218</AgentID></xml>';
const FIXTURE_TIMESTAMP = '1409659589';
const FIXTURE_NONCE = '1871185774';
const FIXTURE_ENCRYPT =
  'sKqRbbiSUnDhFHOvPjtUMZoxPvSvl2GMwNDuzLRAfIzTrB9qsL0vBr9IUNbu9UPk357TYWZRJ5A49gn/bKu5yeNtHxt92MLmwBoBYG8I6CLY1xz8BBz/CYjOPNFO1WjmNYEm4JkQH4Vk4HAae9FsVG66qJgfP1SnpU17w4au2FjHGaRkLd9NGgwI5yH5g+45AqN5TsmovHVfEUBGFId6Vas1exkbYjFAkIhRGQ+jrgD03U8cKU9Oc/G6uC1zE2RP/UBTfACV3DTGDrGyu6ldAuZsMXh80bQgCoUd0twqUppmx/HioOi01M/IKqYjCwtrhG/SFbe6kVeAas85fw7KIFcIvMzoR+qdE2j1CyuAaWWYraZaIhz78FqEJZNcrh2ybOlT6pc0KBnzZ4CJB1ntL550QV65yp/EsOYHnOFd1xni19W1HMi7dsDPqYNRpvxJ4+L7S6ztI7giav+9t1Re0w==';
/** 签名由 sha1sum 独立计算：sort(token,timestamp,nonce,encrypt).join('')。 */
const FIXTURE_SIGNATURE = '68f84419955d4c218d31635e94807d93059b1134';

function crypt(): WxbizMsgCrypt {
  return new WxbizMsgCrypt(TOKEN, AES_KEY, CORP_ID);
}

describe('WxbizMsgCrypt', () => {
  it('构造函数拒绝长度不是 43 的 EncodingAESKey', () => {
    expect(() => new WxbizMsgCrypt(TOKEN, 'too-short', CORP_ID)).toThrow();
  });

  it('decryptMsg 用独立 fixture 验证解密 + 签名校验', () => {
    const plain = crypt().decryptMsg(
      FIXTURE_SIGNATURE,
      FIXTURE_TIMESTAMP,
      FIXTURE_NONCE,
      FIXTURE_ENCRYPT,
    );
    expect(plain).toBe(FIXTURE_PLAINTEXT);
  });

  it('签名算法 = sha1(sort(token,timestamp,nonce,encrypt).join(""))（手算比对）', () => {
    // 期望值由系统 sha1sum 独立算出：printf '14096595891871185774QDG6eKcipherX' | sha1sum
    const expected = createHash('sha1')
      .update(['QDG6eK', '1409659589', '1871185774', 'cipherX'].sort().join(''))
      .digest('hex');
    expect(expected).toBe('563229b6d22b5801625c4764189f7e5a5847c868');
  });

  it('verifyUrl 解密 echostr 并返回明文', () => {
    const { encrypt, msgSignature, nonce, timestamp } =
      crypt().encrypt('161111111111111111');
    const plain = crypt().verifyUrl(
      msgSignature,
      timestamp,
      nonce,
      encrypt,
    );
    expect(plain).toBe('161111111111111111');
  });

  it('篡改签名时 decryptMsg 抛错', () => {
    const tampered = `0${FIXTURE_SIGNATURE.slice(1)}`;
    expect(() =>
      crypt().decryptMsg(
        tampered,
        FIXTURE_TIMESTAMP,
        FIXTURE_NONCE,
        FIXTURE_ENCRYPT,
      ),
    ).toThrow();
  });

  it('篡改密文但保留原签名时抛错', () => {
    const tampered = `A${FIXTURE_ENCRYPT.slice(1)}`;
    expect(() =>
      crypt().decryptMsg(
        FIXTURE_SIGNATURE,
        FIXTURE_TIMESTAMP,
        FIXTURE_NONCE,
        tampered,
      ),
    ).toThrow();
  });

  it('篡改 timestamp 时抛错', () => {
    expect(() =>
      crypt().decryptMsg(
        FIXTURE_SIGNATURE,
        '1409659590',
        FIXTURE_NONCE,
        FIXTURE_ENCRYPT,
      ),
    ).toThrow();
  });

  it('encrypt → decryptMsg 往返一致（含中文多字节）', () => {
    const message = 'python 热榜第 1 名：repo/name — 一些描述 🚀';
    const { encrypt, msgSignature, nonce, timestamp } = crypt().encrypt(message);
    const plain = crypt().decryptMsg(msgSignature, timestamp, nonce, encrypt);
    expect(plain).toBe(message);
  });

  it('多次 encrypt 密文不重复（随机 IV 前缀生效）', () => {
    const a = crypt().encrypt('same message');
    const b = crypt().encrypt('same message');
    expect(a.encrypt).not.toBe(b.encrypt);
  });

  it('receiveid 与 corpId 不匹配时抛错', () => {
    const other = new WxbizMsgCrypt(TOKEN, AES_KEY, 'wx0000000000000000');
    const { encrypt, msgSignature, nonce, timestamp } = crypt().encrypt('hi');
    expect(() =>
      other.decryptMsg(msgSignature, timestamp, nonce, encrypt),
    ).toThrow();
  });
});
