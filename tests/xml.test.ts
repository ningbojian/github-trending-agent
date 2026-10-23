import { describe, expect, it } from 'vitest';
import { buildReplyTextXml, extractTag } from '../src/wecom/xml';

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
