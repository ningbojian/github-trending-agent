import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, {
  buildAckContent,
  type CallbackRequest,
  type CallbackResponse,
  maxDuration,
} from '../api/wecom-callback';
import { WxbizMsgCrypt } from '../src/wecom/crypto';
import { extractTag } from '../src/wecom/xml';
import {
  registerHandlers,
  resetHandlers,
  type InboundMessage,
} from '../src/wecom/router';

/**
 * env 惰性单例策略：本文件用 vi.mock 固定 src/config（而非设 process.env），
 * 避免 Proxy 缓存跨文件串味。凭据为企微官方文档公开样例值（非真实密钥）。
 */
const { TOKEN, AES_KEY, CORP_ID } = vi.hoisted(() => ({
  TOKEN: 'QDG6eK',
  AES_KEY: 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C',
  CORP_ID: 'wx5823bf96d3bd56c7',
}));

vi.mock('../src/config', () => ({
  env: {
    WECOM_CORP_ID: CORP_ID,
    WECOM_AGENT_ID: '1000002',
    WECOM_SECRET: 'unit-test-secret',
    WECOM_CALLBACK_TOKEN: TOKEN,
    WECOM_CALLBACK_AES_KEY: AES_KEY,
  },
}));

/**
 * db mock（供 src/wecom/api 的 kv_cache 读写）。
 * 桩沿用 enrich.test.ts 的宽松风格：只记录调用，不拟合 drizzle 内部类型。
 */
const dbState = vi.hoisted(() => ({
  selectCalls: 0,
  selectRows: [] as Array<Record<string, unknown>>,
  insertValues: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/db/client', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => {
          dbState.selectCalls += 1;
          return Promise.resolve([...dbState.selectRows]);
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbState.insertValues.push(values);
        return {
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
  }),
}));

const { getWeComAccessToken, resetAccessTokenCache, sendWeComText } = await import(
  '../src/wecom/api'
);

/**
 * 平台 waitUntil 桩：生产上 Vercel 响应发出后可能回收实例，fire-and-forget 的
 * 分发会被掐死（实测 200 返回但 subscribers/kv_cache 零写入）。dispatch promise
 * 必须交给 @vercel/functions 的 waitUntil 由平台跟踪，实例才能活到落定。
 */
const waitUntilState = vi.hoisted(() => ({
  calls: [] as Array<Promise<unknown>>,
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilState.calls.push(promise);
  },
}));

/** Task 6：enter_agent 的礼包流程单独测；回调链路只验证「事件被解析并分发给它」。 */
const welcomeMock = vi.hoisted(() => ({ sendWelcomeFlow: vi.fn() }));

// onboarding 会 `export { WELCOME_MESSAGE } from './welcome.js'`；
// mock 里补上该导出，避免 re-export 绑定在 mock 模块上解析失败。
vi.mock('../src/wecom/welcome', () => ({
  sendWelcomeFlow: welcomeMock.sendWelcomeFlow,
  WELCOME_MESSAGE: '欢迎',
}));

function crypt(): WxbizMsgCrypt {
  return new WxbizMsgCrypt(TOKEN, AES_KEY, CORP_ID);
}

/**
 * 解开被动回执的加密信封：从响应体取 Encrypt/MsgSignature/TimeStamp/Nonce，
 * 验签解密返回内层明文回执 XML（回调开启安全模式后回执必须是信封形态）。
 */
function ackPlain(res: { body?: string }): string {
  const body = res.body ?? '';
  return crypt().decryptMsg(
    extractTag(body, 'MsgSignature'),
    extractTag(body, 'TimeStamp'),
    extractTag(body, 'Nonce'),
    extractTag(body, 'Encrypt'),
  );
}

/** 构造解密后的入站消息 XML。 */
function inboundXml(
  overrides: Partial<{
    fromUserName: string;
    msgType: string;
    content: string;
    msgId: string;
    event: string;
  }> = {},
): string {
  const {
    fromUserName = 'alice',
    msgType = 'text',
    content = 'python 热榜',
    msgId = '1001',
    event = '',
  } = overrides;
  const eventXml =
    event === '' ? '' : `<Event><![CDATA[${event}]]></Event>`;
  return `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[${fromUserName}]]></FromUserName><CreateTime>1409659813</CreateTime><MsgType><![CDATA[${msgType}]]></MsgType><Content><![CDATA[${content}]]></Content>${eventXml}<MsgId><![CDATA[${msgId}]]></MsgId></xml>`;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as string | undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res as CallbackResponse & {
    statusCode: number;
    body: string | undefined;
  };
}

/** 构造外层 POST 报文（含 Encrypt 密文与签名 query）。 */
function postRequest(plain: string): {
  req: CallbackRequest;
  res: ReturnType<typeof mockRes>;
} {
  const { encrypt, msgSignature, nonce, timestamp } = crypt().encrypt(plain);
  const outer = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[alice]]></FromUserName><CreateTime>1409659813</CreateTime><MsgType><![CDATA[text]]></MsgType><AgentID>218</AgentID><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  return {
    req: {
      method: 'POST',
      query: { msg_signature: msgSignature, timestamp, nonce },
      body: outer,
    },
    res: mockRes(),
  };
}

/** 冲刷微任务队列（含 setImmediate 阶段），确保 async 分发完成。 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const helpHandler = vi.fn();
const favoriteHandler = vi.fn();
const searchHandler = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilState.calls.length = 0;
  dbState.selectCalls = 0;
  dbState.selectRows = [];
  dbState.insertValues = [];
  resetHandlers();
  resetAccessTokenCache();
  welcomeMock.sendWelcomeFlow.mockReset();
  welcomeMock.sendWelcomeFlow.mockResolvedValue(undefined);
  registerHandlers({
    help: helpHandler,
    favorite: favoriteHandler,
    search: searchHandler,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/wecom-callback — URL 验证', () => {
  it('验签通过时返回解密后的明文（echostr 原文）', () => {
    const echostr = '161111111111111111';
    const { encrypt, msgSignature, nonce, timestamp } = crypt().encrypt(echostr);
    const res = mockRes();

    handler(
      {
        method: 'GET',
        query: { msg_signature: msgSignature, timestamp, nonce, echostr: encrypt },
        body: undefined,
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(echostr);
  });

  it('签名不匹配时返回 401，不泄露明文', () => {
    const { encrypt, nonce, timestamp } = crypt().encrypt('161111111111111111');
    const res = mockRes();

    handler(
      {
        method: 'GET',
        query: {
          msg_signature: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          timestamp,
          nonce,
          echostr: encrypt,
        },
        body: undefined,
      },
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toBe('161111111111111111');
  });
});

describe('POST /api/wecom-callback — 解密 + 异步分发时序', () => {
  beforeEach(() => {
    // Task 13：路由前会先 ensureSubscriber；钉一行「已开通」的订阅者，
    // 让分发测试不走新用户欢迎语路径（欢迎语推送不得在单测中触网）。
    dbState.selectRows = [{ wecomUserid: 'alice', active: true }];
  });

  it('先返回 200 回执 XML，handler 在响应返回之后才被调用（5 秒规则关键时序）', async () => {
    const events: string[] = [];
    searchHandler.mockImplementation(() => {
      events.push('handler');
    });
    const { req, res } = postRequest(inboundXml({ content: 'rust web 框架' }));

    // 不 await：模拟 serverless 直接拿到返回值。
    handler(req, res);

    // 同步断言：响应已经发出（回执 XML 已在响应体），handler 尚未被调用。
    expect(res.statusCode).toBe(200);
    expect(ackPlain(res)).toContain('🔍 收到');
    expect(searchHandler).not.toHaveBeenCalled();
    events.push('response');

    await flushAsync();

    // 响应之后 handler 才被异步调用，且顺序为 response → handler。
    expect(searchHandler).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['response', 'handler']);
  });

  it('解密后的字段完整映射到 InboundMessage', async () => {
    const { req, res } = postRequest(inboundXml({ fromUserName: 'bob' }));

    handler(req, res);
    await flushAsync();

    expect(searchHandler).toHaveBeenCalledTimes(1);
    const msg: InboundMessage = searchHandler.mock.calls[0]?.[0];
    expect(msg).toEqual({
      toUserName: CORP_ID,
      fromUserName: 'bob',
      createTime: 1409659813,
      msgType: 'text',
      content: 'python 热榜',
      msgId: '1001',
      event: '',
    });
    expect(res.statusCode).toBe(200);
  });

  it('「帮助」文本经完整链路（解密→解析→路由）进入 helpHandler', async () => {
    const { req, res } = postRequest(inboundXml({ content: '帮助' }));

    handler(req, res);
    await flushAsync();

    expect(helpHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('非 text 消息（image）解密成功但静默忽略，不触发任何 handler', async () => {
    const { req, res } = postRequest(
      inboundXml({ msgType: 'image', content: '' }),
    );

    handler(req, res);
    await flushAsync();

    expect(helpHandler).not.toHaveBeenCalled();
    expect(favoriteHandler).not.toHaveBeenCalled();
    expect(searchHandler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('enter_agent 事件（新用户）→ 解析出 Event 并异步送礼包，事件不可被动回复（200 空串）', async () => {
    dbState.selectRows = []; // 新用户：ensureSubscriber 走 insert

    const { req, res } = postRequest(
      inboundXml({ msgType: 'event', event: 'enter_agent', content: '' }),
    );

    handler(req, res);

    // 事件消息没有被动回复通道：响应体必须是空串（text 才带回执 XML）。
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');

    await flushAsync();

    expect(welcomeMock.sendWelcomeFlow).toHaveBeenCalledTimes(1);
    expect(welcomeMock.sendWelcomeFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUserName: 'alice',
        msgType: 'event',
        event: 'enter_agent',
      }),
    );
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('签名校验失败（msg_signature 错误）→ 401，且不再分发', async () => {
    const { req, res } = postRequest(inboundXml());
    req.query.msg_signature = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    handler(req, res);
    await flushAsync();

    expect(res.statusCode).toBe(401);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('body 为 Buffer 时也能解析（Vercel getBodyParser 对 application/octet-stream 的行为）', async () => {
    const { req, res } = postRequest(inboundXml());
    req.body = Buffer.from(req.body as string, 'utf8');

    handler(req, res);
    await flushAsync();

    expect(res.statusCode).toBe(200);
    expect(searchHandler).toHaveBeenCalledTimes(1);
  });

  it('handler 抛错：ack 已在响应体，兜底文案经 message/send 回发，routeMessage 不再 reject', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 兜底回发走真实 sendWeComText 链路：kv token 命中 + fetch 返回 errcode 0。
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'tok-123' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      { wecomUserid: 'alice', active: true },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    searchHandler.mockRejectedValue(new Error('handler blew up'));
    const { req, res } = postRequest(inboundXml({ content: 'anything' }));

    handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(ackPlain(res)).toContain('🔍 收到');
    await waitUntilState.calls[0];

    expect(errorSpy).toHaveBeenCalledWith(
      'handler failed:',
      expect.objectContaining({ message: 'handler blew up' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=tok-123',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      touser: 'alice',
      msgtype: 'text',
      agentid: 1000002,
      text: { content: '⚙️ 处理遇到问题，请稍后再试' },
    });
    errorSpy.mockRestore();
  });
});

describe('POST 响应后的异步分发经 waitUntil 交给平台跟踪', () => {
  beforeEach(() => {
    // 与分发时序测试同理：钉「已开通」订阅者，走 search 直发路径。
    dbState.selectRows = [{ wecomUserid: 'alice', active: true }];
  });

  it('dispatch promise 注册给 waitUntil 恰好一次，200 回执仍立即发出', async () => {
    const { req, res } = postRequest(inboundXml({ content: 'anything' }));

    handler(req, res);

    // 5 秒规则不变：同步断言响应已发出（回执 XML 已在响应体）。
    expect(res.statusCode).toBe(200);
    expect(ackPlain(res)).toContain('🔍 收到');
    // 平台必须拿到 dispatch promise，才能在响应回收实例后让分发活到落定。
    expect(waitUntilState.calls).toHaveLength(1);
    expect(waitUntilState.calls[0]).toBeInstanceOf(Promise);

    // waitUntil 收到的就是分发 promise：等它落定，search 已被调用。
    await waitUntilState.calls[0];
    expect(searchHandler).toHaveBeenCalledTimes(1);
  });

  it('handler 抛错时 waitUntil 收到的仍是永不 reject 的 promise（兜底在 router 内完成）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 兜底回发需要真实 sendWeComText 链路：kv token 命中 + fetch 返回 errcode 0。
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'tok-123' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      { wecomUserid: 'alice', active: true },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    searchHandler.mockRejectedValue(new Error('handler blew up'));
    const { req, res } = postRequest(inboundXml({ content: 'anything' }));

    handler(req, res);

    expect(waitUntilState.calls).toHaveLength(1);
    await expect(waitUntilState.calls[0]).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      'handler failed:',
      expect.objectContaining({ message: 'handler blew up' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('buildAckContent — 即时回执文案', () => {
  it('短内容完整回显', () => {
    expect(buildAckContent('帮助')).toBe('🔍 收到，正在处理「帮助」…');
  });

  it('超过 20 码点截断到 20', () => {
    expect(buildAckContent('x'.repeat(50))).toBe(
      `🔍 收到，正在处理「${'x'.repeat(20)}」…`,
    );
  });

  it('按码点截断：emoji 各计 1 个', () => {
    expect(buildAckContent('🤖'.repeat(30))).toBe(
      `🔍 收到，正在处理「${'🤖'.repeat(20)}」…`,
    );
  });

  it('maxChars 可自定义截断长度', () => {
    expect(buildAckContent('abcdefg', 3)).toBe('🔍 收到，正在处理「abc」…');
  });
});

describe('POST text 消息的被动回执 XML（5 秒窗口）', () => {
  beforeEach(() => {
    dbState.selectRows = [{ wecomUserid: 'alice', active: true }];
  });

  it('text 消息响应体为加密信封，解密后内层为回执 XML：To/From 对调、MsgType text、字段顺序、回执文案', () => {
    const { req, res } = postRequest(
      inboundXml({ fromUserName: 'bob', content: 'python 热榜' }),
    );

    handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body ?? '';
    // （a）信封层：Encrypt 非空、MsgSignature 40 位小写十六进制、TimeStamp 裸数字（无 CDATA）、
    // Nonce 非空，字段顺序钉死 Encrypt → MsgSignature → TimeStamp → Nonce。
    expect(body).toMatch(/<Encrypt><!\[CDATA\[[\s\S]+?\]\]><\/Encrypt>/);
    expect(body).toMatch(
      /<MsgSignature><!\[CDATA\[[0-9a-f]{40}\]\]><\/MsgSignature>/,
    );
    expect(body).toMatch(/<TimeStamp>\d+<\/TimeStamp>/);
    expect(body).not.toContain('<TimeStamp><![CDATA[');
    expect(body).toMatch(/<Nonce><!\[CDATA\[[\s\S]+?\]\]><\/Nonce>/);
    expect(body.indexOf('<Encrypt>')).toBeLessThan(
      body.indexOf('<MsgSignature>'),
    );
    expect(body.indexOf('<MsgSignature>')).toBeLessThan(
      body.indexOf('<TimeStamp>'),
    );
    expect(body.indexOf('<TimeStamp>')).toBeLessThan(body.indexOf('<Nonce>'));

    // （b）内层明文：验签解密后原断言全保留。
    const plain = ackPlain(res);
    expect(extractTag(plain, 'ToUserName')).toBe('bob');
    expect(extractTag(plain, 'FromUserName')).toBe(CORP_ID);
    expect(extractTag(plain, 'MsgType')).toBe('text');
    expect(extractTag(plain, 'Content')).toContain('🔍 收到，正在处理');
    expect(extractTag(plain, 'Content')).toContain('python 热榜');
    expect(Number(extractTag(plain, 'CreateTime'))).toBeGreaterThan(1700000000);
    // 字段顺序钉死：ToUserName → FromUserName → CreateTime → MsgType → Content
    expect(plain.indexOf('<ToUserName>')).toBeLessThan(
      plain.indexOf('<FromUserName>'),
    );
    expect(plain.indexOf('<FromUserName>')).toBeLessThan(
      plain.indexOf('<CreateTime>'),
    );
    expect(plain.indexOf('<CreateTime>')).toBeLessThan(
      plain.indexOf('<MsgType>'),
    );
    expect(plain.indexOf('<MsgType>')).toBeLessThan(plain.indexOf('<Content>'));
  });

  it('入站内容超 20 码点时回执中截断', () => {
    const { req, res } = postRequest(inboundXml({ content: 'x'.repeat(50) }));

    handler(req, res);

    const content = extractTag(ackPlain(res), 'Content');
    expect(content).toContain('x'.repeat(20));
    expect(content).not.toContain('x'.repeat(21));
  });
});

describe('POST body 未被 Vercel 解析（text/xml → undefined，原始字节在回放流上）', () => {
  beforeEach(() => {
    dbState.selectRows = [{ wecomUserid: 'alice', active: true }];
  });

  /**
   * 模拟线上 Vercel addHelpers/restoreBody 的行为：
   * getBodyParser 对 text/xml 返回 undefined，但原始 XML 字节已回放到
   * req 的 data/end 事件上（企微真实 content-type 就是 text/xml）。
   */
  function replayRequest(plain: string) {
    const { req, res } = postRequest(plain);
    const xml = req.body as string;
    req.body = undefined;
    const fake = req as CallbackRequest & {
      on?: (event: string, cb: (chunk?: Buffer) => void) => unknown;
    };
    fake.on = (event, cb) => {
      if (event === 'data') queueMicrotask(() => cb(Buffer.from(xml, 'utf8')));
      if (event === 'end') {
        queueMicrotask(() => queueMicrotask(() => cb()));
      }
      return req;
    };
    return { req, res };
  }

  it('从回放流读回原文后完成验签与分发（线上 text/xml 的真实形态）', async () => {
    const { req, res } = replayRequest(inboundXml({ content: '帮助' }));

    handler(req, res);
    await flushAsync();

    expect(res.statusCode).toBe(200);
    expect(ackPlain(res)).toContain('🔍 收到');
    expect(helpHandler).toHaveBeenCalledTimes(1);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('body 未解析且流不可读（无 on 方法）时回 401 且不分发', async () => {
    const { req, res } = postRequest(inboundXml());
    req.body = undefined;

    handler(req, res);
    await flushAsync();

    expect(res.statusCode).toBe(401);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('回放流 5 秒内不发声：超时回 401 不分发（防挂死兜底）', async () => {
    // 只假 setTimeout/clearTimeout——连 setImmediate 一起假会让 flushAsync 永不触发。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { req, res } = postRequest(inboundXml());
      req.body = undefined;
      const fake = req as CallbackRequest & {
        on?: (event: string, cb: (chunk?: unknown) => void) => unknown;
      };
      fake.on = () => req; // 注册成功但永不 emit

      handler(req, res);
      expect(res.statusCode).toBe(0); // 挂起中，响应未发出

      vi.advanceTimersByTime(5000);
      await flushAsync();

      expect(res.statusCode).toBe(401);
      expect(searchHandler).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        'callback raw body read failed:',
        expect.objectContaining({ message: 'callback body read timeout' }),
      );
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });

  it('回放出错（error 事件）：回 401 不分发', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { req, res } = postRequest(inboundXml());
      req.body = undefined;
      const fake = req as CallbackRequest & {
        on?: (event: string, cb: (chunk?: unknown) => void) => unknown;
      };
      fake.on = (event, cb) => {
        if (event === 'error') queueMicrotask(() => cb(new Error('stream boom')));
        return req;
      };

      handler(req, res);
      await flushAsync();

      expect(res.statusCode).toBe(401);
      expect(searchHandler).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        'callback raw body read failed:',
        expect.objectContaining({ message: 'stream boom' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('getWeComAccessToken — kv_cache + 内存缓存', () => {
  function tokenResponse(token: string): Response {
    return new Response(
      JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        access_token: token,
        expires_in: 7200,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('kv_cache 命中有效 token：不调 gettoken 接口', async () => {
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'cached-token' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];

    const token = await getWeComAccessToken();

    expect(token).toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('内存缓存命中：第二次调用连 kv_cache 都不再读', async () => {
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'cached-token' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];

    await getWeComAccessToken();
    expect(dbState.selectCalls).toBe(1);
    const second = await getWeComAccessToken();

    expect(second).toBe('cached-token');
    expect(dbState.selectCalls).toBe(1); // 内存命中，无第二次 DB 读
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('kv_cache 中的 token 已进入 5 分钟刷新窗口：重新调 gettoken 并回写', async () => {
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'almost-expired' },
        expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      },
    ];
    fetchMock.mockResolvedValueOnce(tokenResponse('fresh-token'));

    const token = await getWeComAccessToken();

    expect(token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://qyapi.weixin.qq.com/cgi-bin/gettoken?',
    );
    expect(dbState.insertValues).toHaveLength(1);
    expect(dbState.insertValues[0]?.key).toBe('wecom_access_token');
    expect(dbState.insertValues[0]?.value).toEqual({ token: 'fresh-token' });
  });

  it('kv_cache 为空：调 gettoken 并写入 kv_cache', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('brand-new'));

    const token = await getWeComAccessToken();

    expect(token).toBe('brand-new');
    expect(dbState.insertValues).toHaveLength(1);
    expect(dbState.insertValues[0]?.value).toEqual({ token: 'brand-new' });
  });

  it('并发冷启动：两个并发调用只触发一次 gettoken 并共享同一 token', async () => {
    // 让 fetch 挂起，模拟慢网络窗口内的并发到达
    let releaseFetch!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () => resolve(tokenResponse('shared-token'));
        }),
    );

    const p1 = getWeComAccessToken();
    const p2 = getWeComAccessToken();
    // kv 读是微任务：等 fetch 真正发起后再放行，确保两个调用都落在挂起窗口内
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    releaseFetch();

    const [t1, t2] = await Promise.all([p1, p2]);

    expect(t1).toBe('shared-token');
    expect(t2).toBe('shared-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbState.selectCalls).toBe(1); // 第二个调用方共享同一 in-flight，不重复读 kv
    expect(dbState.insertValues).toHaveLength(1);
  });

  it('gettoken 返回 errcode 非 0 时抛错', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }), {
        status: 200,
      }),
    );

    await expect(getWeComAccessToken()).rejects.toThrow('40013');
  });
});

describe('sendWeComText', () => {
  it('POST message/send，带 access_token 与正确 body', async () => {
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'tok-123' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendWeComText('bob', '今日热榜');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=tok-123',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      touser: 'bob',
      msgtype: 'text',
      agentid: 1000002,
      text: { content: '今日热榜' },
    });
  });

  it('企微返回 errcode 非 0 时抛错', async () => {
    dbState.selectRows = [
      {
        key: 'wecom_access_token',
        value: { token: 'tok-123' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 81013, errmsg: 'user not found' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendWeComText('nobody', 'hi')).rejects.toThrow('81013');
  });
});

// ---------------------------------------------------------------------------
// Vercel Node 函数配置：maxDuration 经 export 生效（不引入 vercel.json）
// ---------------------------------------------------------------------------
describe('api/wecom-callback — 函数时长上限', () => {
  it('导出 maxDuration = 300（秒）', () => {
    expect(maxDuration).toBe(300);
  });
});
