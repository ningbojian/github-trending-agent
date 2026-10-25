import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 站点根地址解析：邮件里的确认/设置/退订链接都靠它。
 * 重点：cron 发信时没有请求头可回退，必须能拿到 Vercel 自带域名，
 * 否则简报里的链接会指向 localhost，用户点不开、一键退订也失效。
 */
const envState = vi.hoisted(() => ({ PUBLIC_BASE_URL: undefined as string | undefined }));

vi.mock('../src/config', () => ({ env: envState }));

import { resolveBaseUrl } from '../src/email/tokens';

const originalVercelUrl = process.env.VERCEL_URL;

beforeEach(() => {
  envState.PUBLIC_BASE_URL = undefined;
  delete process.env.VERCEL_URL;
});

afterEach(() => {
  if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = originalVercelUrl;
});

describe('resolveBaseUrl', () => {
  it('prefers PUBLIC_BASE_URL and strips trailing slashes', () => {
    envState.PUBLIC_BASE_URL = 'https://digest.example.com/';
    expect(resolveBaseUrl({ host: 'ignored.example.com' })).toBe(
      'https://digest.example.com',
    );
  });

  it('falls back to x-forwarded-host, then host', () => {
    expect(
      resolveBaseUrl({ 'x-forwarded-host': 'edge.example.com', host: 'internal' }),
    ).toBe('https://edge.example.com');
    expect(resolveBaseUrl({ host: 'agent.example.com' })).toBe(
      'https://agent.example.com',
    );
  });

  it('falls back to VERCEL_URL when there are no request headers (cron path)', () => {
    process.env.VERCEL_URL = 'github-trending-agent.vercel.app';
    expect(resolveBaseUrl()).toBe('https://github-trending-agent.vercel.app');
  });

  it('only uses localhost when nothing at all is available (local dev)', () => {
    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });
});
