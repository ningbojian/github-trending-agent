import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config';

const fullEnv = {
  NEON_DATABASE_URL: 'postgresql://user:password@ep-xxxx.neon.tech/neondb',
  LLM_PROVIDER: 'anthropic',
  LLM_API_KEY: 'test-llm-api-key',
  LLM_MODEL: 'claude-sonnet-4-5',
  WECOM_CORP_ID: 'ww-test-corp-id',
  WECOM_AGENT_ID: '1000001',
  WECOM_SECRET: 'test-wecom-secret',
  WECOM_CALLBACK_TOKEN: 'test-callback-token',
  WECOM_CALLBACK_AES_KEY: 'test-aes-key',
  GITHUB_CLIENT_ID: 'test-github-client-id',
  GITHUB_CLIENT_SECRET: 'test-github-client-secret',
  GITHUB_OAUTH_REDIRECT_URI: 'https://example.com/api/github/callback',
  CRON_SECRET: 'test-cron-secret',
  TOKEN_ENCRYPT_KEY: 'test-token-encrypt-key',
  GITHUB_TOKEN: 'ghp_test-token',
  WECOM_ADMIN_USERID: 'test-admin',
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('throws an error naming NEON_DATABASE_URL when it is missing', () => {
    expect(() => loadEnv({})).toThrow(/NEON_DATABASE_URL/);
  });

  it('throws an error naming NEON_DATABASE_URL when it is an empty string', () => {
    const { NEON_DATABASE_URL: _omitted, ...rest } = fullEnv;
    expect(() => loadEnv({ ...rest, NEON_DATABASE_URL: '' })).toThrow(
      /NEON_DATABASE_URL/,
    );
  });

  it('throws when any other required variable is missing', () => {
    const { WECOM_CORP_ID: _omitted, ...rest } = fullEnv;
    expect(() => loadEnv(rest)).toThrow(/WECOM_CORP_ID/);
  });

  it('returns the parsed object when all variables are present', () => {
    expect(loadEnv(fullEnv)).toEqual(fullEnv);
  });

  it('treats GITHUB_TOKEN and WECOM_ADMIN_USERID as optional', () => {
    const { GITHUB_TOKEN: _gh, WECOM_ADMIN_USERID: _admin, ...required } =
      fullEnv;
    const parsed = loadEnv(required);
    expect(parsed.GITHUB_TOKEN).toBeUndefined();
    expect(parsed.WECOM_ADMIN_USERID).toBeUndefined();
  });

  it('treats empty-string optional variables as unset instead of failing', () => {
    const parsed = loadEnv({ ...fullEnv, GITHUB_TOKEN: '' });
    expect(parsed.GITHUB_TOKEN).toBeUndefined();
    expect(parsed.WECOM_ADMIN_USERID).toBe(fullEnv.WECOM_ADMIN_USERID);
  });
});

describe('env lazy singleton', () => {
  afterEach(() => {
    vi.resetModules();
    for (const key of Object.keys(fullEnv)) {
      delete process.env[key];
    }
  });

  it('does not validate at import time, only on first property access', async () => {
    vi.resetModules();
    for (const key of Object.keys(fullEnv)) {
      delete process.env[key];
    }

    // Importing the module with an empty process.env must not throw.
    const mod = await import('../src/config');

    // First access triggers validation and throws naming the missing fields.
    expect(() => mod.env.NEON_DATABASE_URL).toThrow(/NEON_DATABASE_URL/);

    // After (re)filling process.env, access parses and caches the values.
    Object.assign(process.env, fullEnv);
    expect(mod.env.NEON_DATABASE_URL).toBe(fullEnv.NEON_DATABASE_URL);
    expect(mod.env.LLM_PROVIDER).toBe(fullEnv.LLM_PROVIDER);
  });
});
