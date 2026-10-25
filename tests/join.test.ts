import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({
  accepting: true,
  emailReady: true,
}));

vi.mock('../src/wecom/capacity', () => ({
  isWeComAccepting: async () => state.accepting,
}));

vi.mock('../src/email/send', () => ({
  emailConfigured: () => state.emailReady,
}));

import handler, { DEFAULT_JOIN_QR_URL, DEFAULT_PLUGIN_QR_URL, renderJoinPage } from '../api/join';
import { BRAND } from '../src/brand';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  status(code: number): MockRes;
  setHeader(name: string, value: string): MockRes;
  send(body: string): MockRes;
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
  };
}

const WECOM_TITLE = '在微信里每天收简报、随时提问';
const EMAIL_TITLE = '只想收邮件？';
const FALLBACK = '如果加入时提示名额已满或无法加入，可直接用邮箱订阅。';

beforeEach(() => {
  state.accepting = true;
  state.emailReady = true;
  delete process.env.WECOM_JOIN_QR_URL;
  delete process.env.WECOM_PLUGIN_QR_URL;
  delete process.env.WECOM_APP_NAME;
});

afterEach(() => {
  delete process.env.WECOM_JOIN_QR_URL;
  delete process.env.WECOM_PLUGIN_QR_URL;
  delete process.env.WECOM_APP_NAME;
});

describe('renderJoinPage', () => {
  it('puts WeCom first with the 推荐 badge while accepting', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: 'GitHub 热榜',
    });
    expect(html.indexOf(WECOM_TITLE)).toBeGreaterThan(-1);
    expect(html.indexOf(WECOM_TITLE)).toBeLessThan(html.indexOf(EMAIL_TITLE));
    // 推荐标记只出现一次，且位于企微卡（在邮箱卡标题之前）。
    expect(html.split('推荐').length - 1).toBe(1);
    expect(html.indexOf('推荐')).toBeLessThan(html.indexOf(EMAIL_TITLE));
  });

  it('keeps the email entry visible and always shows the fallback copy', () => {
    const accepting = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: 'GitHub 热榜',
    });
    expect(accepting).toContain('/api/subscribe');
    expect(accepting).toContain('用邮箱订阅');
    expect(accepting).toContain(FALLBACK);

    const full = renderJoinPage({
      accepting: false,
      emailReady: true,
      appName: 'GitHub 热榜',
    });
    expect(full).toContain('/api/subscribe');
    expect(full).toContain(FALLBACK);
  });

  it('promotes email and marks WeCom as full when capacity is exhausted', () => {
    const html = renderJoinPage({
      accepting: false,
      emailReady: true,
      appName: 'GitHub 热榜',
    });
    expect(html.indexOf(EMAIL_TITLE)).toBeLessThan(html.indexOf(WECOM_TITLE));
    expect(html).toContain('企微名额已满，暂不开放；邮箱订阅照常。');
    expect(html.split('推荐').length - 1).toBe(1);
    expect(html.indexOf('推荐')).toBeLessThan(html.indexOf(WECOM_TITLE));
  });

  it('degrades the email card when Resend is not configured yet', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: false,
      appName: 'GitHub 热榜',
    });
    expect(html).toContain('邮箱订阅即将开放');
    // 企微卡的兜底文案里含有「用邮箱订阅」这几个字，所以按按钮锚点断言而不是按文案。
    expect(html).not.toContain('href="/api/subscribe"');
  });

  it('lists advantages only（不贬低任何一方，不提企业微信下载）', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: 'GitHub 热榜',
    });
    expect(html).toContain('每天自动收到 GitHub 热榜简报');
    expect(html).toContain('直接在微信里提问');
    expect(html).toContain('全程在微信内完成，无需下载企业微信');
    expect(html).toContain('不用加入企业，任何邮箱都行');
    expect(html).toContain('方便转发给同事');
  });

  it('renders the three-step WeCom instructions with the app name', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: '热榜助手',
      joinQrUrl: '/join.png',
      pluginQrUrl: '/plugin.png',
    });
    expect(html).toContain('扫码加入企业');
    expect(html).toContain('企业微信插件');
    expect(html).toContain('给「热榜助手」发一句「你好」');
  });

  it('labels each QR so users know which one to scan', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: 'GitHub 热榜',
      joinQrUrl: '/join.png',
      pluginQrUrl: '/plugin.png',
    });
    expect(html).toContain('alt="加入企业二维码"');
    expect(html).toContain('alt="微信插件二维码"');
  });

  it('never tells users to scan a QR that is not rendered', () => {
    // 没配二维码时旧版仍然写着「扫码加入企业」，下面却一片空白 —— 死路。
    const html = renderJoinPage({ accepting: true, emailReady: true, appName: 'GitHub 热榜' });
    expect(html).not.toContain('扫码加入企业');
    expect(html).not.toContain('<img');
    expect(html).toContain('向管理员索要企业邀请链接');
  });

  it('只配了一个二维码时，另一张不会留下空占位', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: 'GitHub 热榜',
      pluginQrUrl: '/plugin.png',
    });
    expect(html).toContain('src="/plugin.png"');
    expect(html).not.toContain('alt="加入企业二维码"');
  });

  it('escapes the app name', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: '<script>x</script>',
    });
    expect(html).not.toContain('<script>x</script>');
  });

  it('uses the brand accent for the primary CTA（防止再次写死绿色）', () => {
    const html = renderJoinPage({
      accepting: true,
      emailReady: true,
      appName: 'GitHub 热榜',
    });
    expect(html).toContain(`background:${BRAND.colors.accent}`);
    expect(html).not.toContain('#1a7f37');
    expect(html).not.toContain('#dafbe1');
  });
});

describe('GET /api/join', () => {
  it('renders the page with QR images when the env is set', async () => {
    process.env.WECOM_JOIN_QR_URL = 'https://cdn.example.com/join.png';
    process.env.WECOM_PLUGIN_QR_URL = 'https://cdn.example.com/plugin.png';
    process.env.WECOM_APP_NAME = '热榜助手';
    const res = mockRes();

    await handler({ method: 'GET' }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('src="https://cdn.example.com/join.png"');
    expect(res.body).toContain('src="https://cdn.example.com/plugin.png"');
    expect(res.body).toContain('给「热榜助手」发一句「你好」');
  });

  it('defaults to the QR assets shipped in the repo', async () => {
    const res = mockRes();
    await handler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`src="${DEFAULT_JOIN_QR_URL}"`);
    expect(res.body).toContain(`src="${DEFAULT_PLUGIN_QR_URL}"`);
  });

  it('ships the default QR assets as real PNGs', () => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const url of [DEFAULT_JOIN_QR_URL, DEFAULT_PLUGIN_QR_URL]) {
      const path = url.replace(/^\//, '');
      expect(existsSync(path), path).toBe(true);
      expect([...readFileSync(path).subarray(0, 8)], path).toEqual(signature);
    }
  });

  it('falls back to the default app name', async () => {
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('给「GitHub 热榜」发一句「你好」');
  });

  it('reflects capacity state from the probe', async () => {
    state.accepting = false;
    const res = mockRes();
    await handler({ method: 'GET' }, res);
    expect(res.body).toContain('企微名额已满，暂不开放');
  });

  it('rejects non-GET with 405', async () => {
    const res = mockRes();
    await handler({ method: 'POST' }, res);
    expect(res.statusCode).toBe(405);
  });
});
