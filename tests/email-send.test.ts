import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * env 用 vi.mock 固定（避免 process.env 跨文件串味）；两个字段可逐用例改写，
 * 用于覆盖「已配置 / 未配置」两种状态。凭据为单元测试专用假值。
 */
const EMAIL_ENV = vi.hoisted(() => ({
  RESEND_API_KEY: 're_unit_test_key' as string | undefined,
  EMAIL_FROM: 'GitHub 热榜 <digest@mail.example.com>' as string | undefined,
}));

vi.mock('../src/config', () => ({ env: EMAIL_ENV }));

import { emailConfigured, sendEmail } from '../src/email/send';

type FetchStep = Error | { ok: boolean; status: number };

/** 按顺序应答的 fetch 桩：Error → 网络错误 reject；其余 → Response 形态。 */
function stubFetch(steps: FetchStep[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const step of steps) {
    if (step instanceof Error) {
      fetchMock.mockRejectedValueOnce(step);
    } else {
      fetchMock.mockResolvedValueOnce({ ok: step.ok, status: step.status });
    }
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MESSAGE = {
  to: 'reader@example.com',
  subject: 'GitHub 热榜简报 · 10-25',
  text: '纯文本正文',
  html: '<p>HTML 正文</p>',
};

beforeEach(() => {
  EMAIL_ENV.RESEND_API_KEY = 're_unit_test_key';
  EMAIL_ENV.EMAIL_FROM = 'GitHub 热榜 <digest@mail.example.com>';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emailConfigured', () => {
  it('requires both RESEND_API_KEY and EMAIL_FROM', () => {
    expect(emailConfigured()).toBe(true);
    EMAIL_ENV.RESEND_API_KEY = undefined;
    expect(emailConfigured()).toBe(false);
    EMAIL_ENV.RESEND_API_KEY = 're_unit_test_key';
    EMAIL_ENV.EMAIL_FROM = undefined;
    expect(emailConfigured()).toBe(false);
    EMAIL_ENV.EMAIL_FROM = '';
    expect(emailConfigured()).toBe(false);
  });
});

describe('sendEmail', () => {
  it('throws without touching the network when unconfigured', async () => {
    EMAIL_ENV.RESEND_API_KEY = undefined;
    const fetchMock = stubFetch([]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow('email not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the Resend payload with bearer auth and no empty headers field', async () => {
    const fetchMock = stubFetch([{ ok: true, status: 200 }]);
    await sendEmail(MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer re_unit_test_key');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      from: 'GitHub 热榜 <digest@mail.example.com>',
      to: ['reader@example.com'],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
    expect(JSON.parse(init.body)).not.toHaveProperty('headers');
  });

  it('forwards custom headers（List-Unsubscribe / 一键退订）', async () => {
    const fetchMock = stubFetch([{ ok: true, status: 200 }]);
    await sendEmail({
      ...MESSAGE,
      headers: {
        'List-Unsubscribe': '<https://example.com/api/email-unsubscribe?t=abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.headers).toEqual({
      'List-Unsubscribe': '<https://example.com/api/email-unsubscribe?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('retries once on 5xx and then succeeds', async () => {
    const fetchMock = stubFetch([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    await sendEmail(MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on 429', async () => {
    const fetchMock = stubFetch([
      { ok: false, status: 429 },
      { ok: true, status: 200 },
    ]);
    await sendEmail(MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a network error then rethrows a second failure', async () => {
    const fetchMock = stubFetch([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx', async () => {
    const fetchMock = stubFetch([{ ok: false, status: 422 }]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow('resend HTTP 422');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry on persistent 5xx', async () => {
    const fetchMock = stubFetch([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ]);
    await expect(sendEmail(MESSAGE)).rejects.toThrow('resend HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
