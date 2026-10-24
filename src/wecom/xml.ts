import type { InboundMessage } from './router.js';

/**
 * 企微回调 XML 的轻量提取器。
 * 入站报文形态固定（CDATA 或纯文本子节点），无需引入完整 XML 解析库。
 */

/** 转义正则元字符，防止 tag 名被解释为模式片段。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 提取 <tag><![CDATA[value]]></tag> 或 <tag>value</tag>；缺失时返回 ''。 */
export function extractTag(xml: string, tag: string): string {
  const safeTag = escapeRegExp(tag);
  const cdata = xml.match(
    new RegExp(`<${safeTag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${safeTag}>`),
  );
  if (cdata) return cdata[1] ?? '';
  const plain = xml.match(new RegExp(`<${safeTag}>([\\s\\S]*?)</${safeTag}>`));
  return plain ? (plain[1] ?? '') : '';
}

/** 解析解密后的入站消息 XML 为 InboundMessage。 */
export function parseInboundXml(xml: string): InboundMessage {
  return {
    toUserName: extractTag(xml, 'ToUserName'),
    fromUserName: extractTag(xml, 'FromUserName'),
    createTime: Number(extractTag(xml, 'CreateTime')) || 0,
    msgType: extractTag(xml, 'MsgType'),
    content: extractTag(xml, 'Content'),
    msgId: extractTag(xml, 'MsgId'),
  };
}

/**
 * XML 1.0 合法性过滤：按码点保留 #x9/#xA/#xD、#x20-#xD7FF、#xE000-#xFFFD、
 * #x10000-#x10FFFF——即剥掉 NUL/BEL/ESC 等 C0 控制字符与 #xFFFE/#xFFFF，
 * 恰好保留制表/换行/回车（与计划规定的正则集合一致，另顺带剥掉孤立代理项）。
 */
function stripIllegalXmlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const legal =
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0d ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      (c >= 0x10000 && c <= 0x10ffff);
    if (legal) out += ch;
  }
  return out;
}

/** CDATA 内容安全化：剥非法控制字符；]]> 拆成两段 CDATA（CDATA 唯一破口）。 */
function cdataEscape(s: string): string {
  return stripIllegalXmlChars(s)
    .split(']]>')
    .join(']]]]><![CDATA[>');
}

/**
 * 构造被动回复 text 消息 XML（随 5 秒回调响应体返回，每条入站消息仅此一次回复机会）。
 * 字段顺序钉死 ToUserName→FromUserName→CreateTime→MsgType(text)→Content，无 XML 声明；
 * 调用方负责 To/From 对调（To=入站 FromUserName 用户，From=入站 ToUserName corpid）。
 * createTime 缺省取当前 Unix 秒；builder 不截断（调用方负责长度）。
 */
export function buildReplyTextXml(opts: {
  toUserName: string;
  fromUserName: string;
  content: string;
  createTime?: number;
}): string {
  const createTime = opts.createTime ?? Math.floor(Date.now() / 1000);
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${cdataEscape(opts.toUserName)}]]></ToUserName>` +
    `<FromUserName><![CDATA[${cdataEscape(opts.fromUserName)}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime>` +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${cdataEscape(opts.content)}]]></Content>` +
    '</xml>'
  );
}

/**
 * 构造被动回复的加密信封：回调开启安全模式后，被动回执 HTTP 体必须是
 * `<xml><Encrypt>…<MsgSignature>…<TimeStamp>…<Nonce>…</xml>` 信封形态，
 * 明文回执 XML 会被企微静默丢弃（真机不可见）。
 * 字段顺序钉死 Encrypt→MsgSignature→TimeStamp→Nonce；
 * Encrypt/MsgSignature/Nonce 包 CDATA，TimeStamp 为裸整数（大写 S）。
 * 各字段由 WxbizMsgCrypt.encrypt 产出（base64 密文/十六进制签名与 nonce），无需再转义。
 */
export function buildReplyEnvelope(parts: {
  encrypt: string;
  msgSignature: string;
  timestamp: string | number;
  nonce: string;
}): string {
  return (
    '<xml>' +
    `<Encrypt><![CDATA[${parts.encrypt}]]></Encrypt>` +
    `<MsgSignature><![CDATA[${parts.msgSignature}]]></MsgSignature>` +
    `<TimeStamp>${parts.timestamp}</TimeStamp>` +
    `<Nonce><![CDATA[${parts.nonce}]]></Nonce>` +
    '</xml>'
  );
}
