import type { InboundMessage } from './router';

/**
 * 企微回调 XML 的轻量提取器。
 * 入站报文形态固定（CDATA 或纯文本子节点），无需引入完整 XML 解析库。
 */

/** 提取 <tag><![CDATA[value]]></tag> 或 <tag>value</tag>；缺失时返回 ''。 */
export function extractTag(xml: string, tag: string): string {
  const cdata = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`),
  );
  if (cdata) return cdata[1] ?? '';
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
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
