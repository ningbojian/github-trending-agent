import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, {
  type CallbackRequest,
  type CallbackResponse,
} from '../api/wecom-callback';
import { WxbizMsgCrypt } from '../src/wecom/crypto';
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
  selectRows: [] as Array<{ key: string; value: unknown; expiresAt: Date }>,
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

function crypt(): WxbizMsgCrypt {
  return new WxbizMsgCrypt(TOKEN, AES_KEY, CORP_ID);
}

/** 构造解密后的入站消息 XML。 */
function inboundXml(
  overrides: Partial<{
    fromUserName: string;
    msgType: string;
    content: string;
    msgId: string;
  }> = {},
): string {
  const {
    fromUserName = 'alice',
    msgType = 'text',
    content = 'python 热榜',
    msgId = '1001',
  } = overrides;
  return `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[${fromUserName}]]></FromUserName><CreateTime>1409659813</CreateTime><MsgType><![CDATA[${msgType}]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId><![CDATA[${msgId}]]></MsgId></xml>`;
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
  dbState.selectCalls = 0;
  dbState.selectRows = [];
  dbState.insertValues = [];
  resetHandlers();
  resetAccessTokenCache();
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
  it('先返回 200 空串，handler 在响应返回之后才被调用（5 秒规则关键时序）', async () => {
    const events: string[] = [];
    searchHandler.mockImplementation(() => {
      events.push('handler');
    });
    const { req, res } = postRequest(inboundXml({ content: 'rust web 框架' }));

    // 不 await：模拟 serverless 直接拿到返回值。
    handler(req, res);

    // 同步断言：响应已经发出，handler 尚未被调用。
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
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

  it('签名无效时返回 401 且不分发', async () => {
    const { req, res } = postRequest(inboundXml());
    req.query.msg_signature = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    handler(req, res);
    await flushAsync();

    expect(res.statusCode).toBe(401);
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('body 为 Buffer 时也能解析（Vercel 对未知 content-type 的行为）', async () => {
    const { req, res } = postRequest(inboundXml());
    req.body = Buffer.from(req.body as string, 'utf8');

    handler(req, res);
    await flushAsync();

    expect(res.statusCode).toBe(200);
    expect(searchHandler).toHaveBeenCalledTimes(1);
  });

  it('handler 抛错不影响已发出的 200 响应，错误被 catch 记录（不产生 unhandled rejection）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    searchHandler.mockRejectedValue(new Error('handler blew up'));
    const { req, res } = postRequest(inboundXml({ content: 'anything' }));

    handler(req, res);
    expect(res.statusCode).toBe(200);
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(
      'routeMessage failed:',
      expect.objectContaining({ message: 'handler blew up' }),
    );
    errorSpy.mockRestore();
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
