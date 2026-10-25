import { describe, expect, it } from 'vitest';
import { buildReplyTextXml, extractTag, parseInboundXml } from '../src/wecom/xml';

/**
 * 入站解析：事件消息（MsgType=event）靠 Event 字段区分类型。
 * enter_agent 是「加入应用」事件——用户一进入就送礼包（欢迎 + 首日简报），
 * 因此 Event 必须进入 InboundMessage，不能只留在原始 XML 里。
 */
describe('parseInboundXml — Event 字段', () => {
  it('解析 enter_agent 事件：msgType=event 且 event=enter_agent', () => {
    const msg = parseInboundXml(
      '<xml>' +
        '<ToUserName><![CDATA[ww_corp]]></ToUserName>' +
        '<FromUserName><![CDATA[alice]]></FromUserName>' +
        '<CreateTime>1409659813</CreateTime>' +
        '<MsgType><![CDATA[event]]></MsgType>' +
        '<Event><![CDATA[enter_agent]]></Event>' +
        '</xml>',
    );

    expect(msg.msgType).toBe('event');
    expect(msg.event).toBe('enter_agent');
    expect(msg.fromUserName).toBe('alice');
  });

  it('普通 text 消息无 Event 标签 → event 为空串', () => {
    const msg = parseInboundXml(
      '<xml>' +
        '<MsgType><![CDATA[text]]></MsgType>' +
        '<Content><![CDATA[你好]]></Content>' +
        '</xml>',
    );

    expect(msg.msgType).toBe('text');
    expect(msg.event).toBe('');
  });
});

/**
 * 被动回复 text XML：企微 5 秒回调窗口内的唯一回复通道。
 * 字段顺序、CDATA 转义、无 XML 声明都是协议级要求——任一出错静默失败。
 */
describe('buildReplyTextXml — 被动回复 text XML', () => {
  it('字段顺序钉死 ToUserName→FromUserName→CreateTime→MsgType→Content，无 XML 声明', () => {
    const xml = buildReplyTextXml({
      toUserName: 'alice',
      fromUserName: 'ww_corp',
      content: '你好',
      createTime: 1700000000,
    });

    expect(xml).toBe(
      '<xml>' +
        '<ToUserName><![CDATA[alice]]></ToUserName>' +
        '<FromUserName><![CDATA[ww_corp]]></FromUserName>' +
        '<CreateTime>1700000000</CreateTime>' +
        '<MsgType><![CDATA[text]]></MsgType>' +
        '<Content><![CDATA[你好]]></Content>' +
        '</xml>',
    );
    expect(xml.startsWith('<?xml')).toBe(false);
  });

  it('createTime 缺省时取当前 Unix 秒', () => {
    const before = Math.floor(Date.now() / 1000);
    const xml = buildReplyTextXml({
      toUserName: 'a',
      fromUserName: 'b',
      content: 'x',
    });
    const after = Math.floor(Date.now() / 1000);

    const createTime = Number(extractTag(xml, 'CreateTime'));
    expect(createTime).toBeGreaterThanOrEqual(before);
    expect(createTime).toBeLessThanOrEqual(after);
  });

  it('content 含 ]]> 时 CDATA 分段转义，不提前闭合', () => {
    const xml = buildReplyTextXml({
      toUserName: 'u',
      fromUserName: 'f',
      content: 'a]]>b',
      createTime: 1,
    });

    expect(xml).toContain('<Content><![CDATA[a]]]]><![CDATA[>b]]></Content>');
  });

  it('剥离 XML 1.0 非法控制字符（保留 \\t \\n \\r）', () => {
    // NUL/BEL/ESC/FFFE 经 fromCharCode 构造，避免源码里出现原始控制字节。
    const control = String.fromCharCode(0, 7, 27, 0xfffe);
    const xml = buildReplyTextXml({
      toUserName: 'u',
      fromUserName: 'f',
      content: 'ok' + control + '中\n行\tgood\r',
      createTime: 1,
    });

    expect(xml).toContain('<Content><![CDATA[ok中\n行\tgood\r]]></Content>');
    expect(xml.includes(control)).toBe(false);
  });
});
