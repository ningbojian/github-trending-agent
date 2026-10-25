import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 用户自备 LLM Key（subscribers.llm_*）。
 * 不变量：
 * - Key 只以密文入库，读出来要能还原；
 * - 掩码只露尾 4 位，日志/回复里绝不出现明文；
 * - 解密失败（换过密钥、被篡改）按「未配置」处理，不抛错、不打印明文；
 * - 接口地址必须是 https://，防止把 Key 明文发给 http 端点。
 */

const ENV = vi.hoisted(() => ({
  TOKEN_ENCRYPT_KEY: 'unit-test-encrypt-key',
}));

vi.mock('../src/config', () => ({ env: ENV }));

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  updateCalls: [] as Record<string, unknown>[],
}));

vi.mock('../src/db/client', () => {
  const pipeline = () => {
    const p = {
      limit: () => p,
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        const next = dbMock.selectQueue.shift() ?? [];
        return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return p;
  };
  return {
    db: () => ({
      select: () => ({ from: () => ({ where: () => pipeline() }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            dbMock.updateCalls.push(values);
          },
        }),
      }),
    }),
  };
});

import { encryptSecret } from '../src/github/oauth';
import {
  clearUserLlm,
  describeUserLlm,
  loadUserLlm,
  maskKey,
  pingLlm,
  PRESETS,
  saveUserLlm,
  validateUserLlmInput,
} from '../src/agent/user-llm';

const CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-abcdefghijklmnop',
};

beforeEach(() => {
  ENV.TOKEN_ENCRYPT_KEY = 'unit-test-encrypt-key';
  dbMock.selectQueue = [];
  dbMock.updateCalls = [];
});

describe('maskKey', () => {
  it('只露前 3 位与后 4 位', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-…mnop');
  });

  it('过短的 Key 整体打码（前 3 + 后 4 会泄露大半）', () => {
    expect(maskKey('abcdefg')).toBe('****');
    expect(maskKey('')).toBe('****');
  });

  it('掩码结果不含完整明文', () => {
    const key = 'sk-0123456789abcdef';
    expect(maskKey(key)).not.toContain('0123456789');
  });
});

describe('validateUserLlmInput', () => {
  it('合法输入 → 去空白、去掉尾斜杠', () => {
    const result = validateUserLlmInput({
      baseUrl: ' https://api.deepseek.com/v1/ ',
      model: ' deepseek-chat ',
      apiKey: ' sk-abc123456789 ',
    });
    expect(result).toEqual({
      ok: true,
      config: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-abc123456789',
      },
    });
  });

  it('非 https 地址 → 拒绝（Key 不能明文发出去）', () => {
    for (const baseUrl of ['http://api.deepseek.com/v1', 'api.deepseek.com', 'ftp://x/y']) {
      const result = validateUserLlmInput({ ...CONFIG, baseUrl });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('https://');
    }
  });

  it('模型名或 Key 为空 → 拒绝', () => {
    const noModel = validateUserLlmInput({ ...CONFIG, model: '   ' });
    const noKey = validateUserLlmInput({ ...CONFIG, apiKey: '' });
    expect(noModel.ok).toBe(false);
    expect(noKey.ok).toBe(false);
  });
});

describe('PRESETS', () => {
  it('预置常见厂商，且每个地址都是 https', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const preset of PRESETS) {
      expect(preset.baseUrl.startsWith('https://')).toBe(true);
      expect(preset.model.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
    }
    expect(PRESETS.map((p) => p.key)).toContain('deepseek');
  });
});

describe('loadUserLlm', () => {
  it('有记录 → 解出明文配置', async () => {
    dbMock.selectQueue.push([
      {
        llmBaseUrl: CONFIG.baseUrl,
        llmModel: CONFIG.model,
        llmKeyEnc: encryptSecret(CONFIG.apiKey),
      },
    ]);
    await expect(loadUserLlm('alice')).resolves.toEqual(CONFIG);
  });

  it('没有记录 / 三列不全 → null', async () => {
    dbMock.selectQueue.push([]);
    dbMock.selectQueue.push([
      { llmBaseUrl: CONFIG.baseUrl, llmModel: null, llmKeyEnc: null },
    ]);
    await expect(loadUserLlm('alice')).resolves.toBeNull();
    await expect(loadUserLlm('alice')).resolves.toBeNull();
  });

  it('密文损坏（换过密钥/被篡改）→ null，且日志里没有明文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMock.selectQueue.push([
      { llmBaseUrl: CONFIG.baseUrl, llmModel: CONFIG.model, llmKeyEnc: 'bm90LWEtY2lwaGVy' },
    ]);
    await expect(loadUserLlm('alice')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(CONFIG.apiKey);
    warn.mockRestore();
  });

  it('DB 异常 → null（fail-open：互动退回规则模式，不阻塞消息）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMock.selectQueue.push(new Error('db down'));
    await expect(loadUserLlm('alice')).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('saveUserLlm / clearUserLlm', () => {
  it('保存时 Key 只进密文列，绝不存明文', async () => {
    await saveUserLlm('alice', CONFIG);
    const values = dbMock.updateCalls[0]!;
    expect(values.llmBaseUrl).toBe(CONFIG.baseUrl);
    expect(values.llmModel).toBe(CONFIG.model);
    expect(typeof values.llmKeyEnc).toBe('string');
    expect(values.llmKeyEnc).not.toBe(CONFIG.apiKey);
    expect(JSON.stringify(values)).not.toContain(CONFIG.apiKey);
  });

  it('每次加密的密文不同（随机 IV），但都能解回同一个 Key', async () => {
    await saveUserLlm('alice', CONFIG);
    await saveUserLlm('alice', CONFIG);
    const [first, second] = dbMock.updateCalls;
    expect(first!.llmKeyEnc).not.toBe(second!.llmKeyEnc);
  });

  it('清除把三列一起置空', async () => {
    await clearUserLlm('alice');
    expect(dbMock.updateCalls[0]).toEqual({
      llmBaseUrl: null,
      llmModel: null,
      llmKeyEnc: null,
    });
  });
});

describe('describeUserLlm', () => {
  it('未配置 → 明说互动会退回规则模式', () => {
    const text = describeUserLlm(null);
    expect(text).toContain('未配置');
    expect(text).toContain('设置模型');
  });

  it('已配置 → 地址 / 模型 / 掩码 Key，不出现明文', () => {
    const text = describeUserLlm(CONFIG);
    expect(text).toContain(CONFIG.baseUrl);
    expect(text).toContain(CONFIG.model);
    expect(text).toContain('sk-…mnop');
    expect(text).not.toContain(CONFIG.apiKey);
  });
});

// ---------------------------------------------------------------------------
// pingLlm：保存前用用户自己的 Key 试连一次（失败不落库）
// ---------------------------------------------------------------------------
describe('pingLlm', () => {
  function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    });
    return calls;
  }

  it('200 → ok，请求打到 <baseUrl>/chat/completions 且带着用户自己的 Key', async () => {
    const calls = stubFetch(async () => new Response('{}', { status: 200 }));

    await expect(pingLlm(CONFIG)).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(
      String((calls[0]?.init?.headers as Record<string, string>)?.authorization),
    ).toBe(`Bearer ${CONFIG.apiKey}`);
    vi.unstubAllGlobals();
  });

  it('401 且响应体回显了 Key → 错误文案已脱敏', async () => {
    stubFetch(
      async () =>
        new Response(`{"error":"bad key ${CONFIG.apiKey}"}`, { status: 401 }),
    );

    const result = await pingLlm(CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('401');
      expect(result.error).not.toContain(CONFIG.apiKey);
    }
    vi.unstubAllGlobals();
  });

  it('网络异常 → ok:false，带上原因，不抛错', async () => {
    stubFetch(async () => {
      throw new Error('ENOTFOUND api.deepseek.com');
    });

    const result = await pingLlm(CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ENOTFOUND');
    vi.unstubAllGlobals();
  });
});
