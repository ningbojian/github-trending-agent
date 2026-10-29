import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  base: 'https://ghtrending.cyou',
  sent: [] as Array<[string, string]>,
}));

vi.mock('../src/config', () => ({ env: { PUBLIC_BASE_URL: undefined } }));
vi.mock('../src/panel/version', () => ({ getPanelVersion: async () => 1 }));
vi.mock('../src/panel/token', () => ({ signPanelToken: () => 'tok123' }));
vi.mock('../src/email/tokens', () => ({ resolveBaseUrl: () => state.base }));
vi.mock('../src/wecom/api', () => ({
  sendWeComText: async (userid: string, text: string) => {
    state.sent.push([userid, text]);
  },
}));

import { PANEL_UNAVAILABLE_REPLY, handleMyPanel } from '../src/wecom/panel-link';
import type { InboundMessage } from '../src/wecom/router';

function msg(): InboundMessage {
  return {
    toUserName: 'corp',
    fromUserName: 'alice',
    createTime: 0,
    msgType: 'text',
    content: '我的面板',
    msgId: 'm1',
  };
}

describe('handleMyPanel', () => {
  it('发出 7 天有效的签名链接', async () => {
    state.base = 'https://ghtrending.cyou';
    state.sent.length = 0;
    await handleMyPanel(msg());
    const text = state.sent[0]?.[1] ?? '';
    expect(text).toContain('https://ghtrending.cyou/api/panel?t=tok123');
    expect(text).toContain('7 天');
  });

  it('本地/无公网域名时不发点不开的链接', async () => {
    state.base = 'http://localhost:3000';
    state.sent.length = 0;
    await handleMyPanel(msg());
    expect(state.sent[0]?.[1]).toBe(PANEL_UNAVAILABLE_REPLY);
  });
});

describe('panel base url', () => {
  it('优先使用 VERCEL_PROJECT_PRODUCTION_URL，而不是部署域名', async () => {
    const previous = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ghtrending.cyou';
    state.base = 'https://github-trending-agent-abc.vercel.app';
    state.sent.length = 0;
    try {
      await handleMyPanel(msg());
      expect(state.sent[0]?.[1]).toContain('https://ghtrending.cyou/api/panel?t=tok123');
    } finally {
      if (previous === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      else process.env.VERCEL_PROJECT_PRODUCTION_URL = previous;
    }
  });
});
