import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  emailSubscribers,
  favorites,
  kvCache,
  repos,
  searchCaches,
  subscribers,
  trendingEntries,
} from '../src/db/schema';

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .columns.map((column) => column.name)
    .sort();
}

function uniqueCombos(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).uniqueConstraints.map((constraint) =>
    constraint.columns
      .map((column) => column.name)
      .sort()
      .join(','),
  );
}

describe('repos', () => {
  it('defines the repos table with the expected columns', () => {
    const cfg = getTableConfig(repos);
    expect(cfg.name).toBe('repos');
    expect(columnNames(repos)).toEqual([
      'description',
      'full_name',
      'html_url',
      'language',
      'name',
      'owner',
      'stars',
      'topics',
    ]);
    const fullName = cfg.columns.find(
      (column) => column.name === 'full_name',
    );
    expect(fullName?.primary).toBe(true);
  });

  it('stores topics as jsonb', () => {
    const topics = getTableConfig(repos).columns.find(
      (column) => column.name === 'topics',
    );
    expect(topics?.columnType).toBe('PgJsonb');
  });
});

describe('trending_entries', () => {
  it('defines the trending_entries table with the expected columns', () => {
    const cfg = getTableConfig(trendingEntries);
    expect(cfg.name).toBe('trending_entries');
    expect(columnNames(trendingEntries)).toEqual([
      'date',
      'full_name',
      'id',
      'is_new',
      'language',
      'period',
      'rank',
      'source',
      'stars_at_capture',
      'stars_delta',
    ]);
  });

  it('enforces unique(date, period, language, full_name)', () => {
    expect(uniqueCombos(trendingEntries)).toContain(
      'date,full_name,language,period',
    );
  });

  it('references repos(full_name) as a foreign key', () => {
    const cfg = getTableConfig(trendingEntries);
    expect(cfg.foreignKeys).toHaveLength(1);
    const reference = cfg.foreignKeys[0].reference();
    expect(reference.foreignColumns.map((column) => column.name)).toEqual([
      'full_name',
    ]);
  });

  it('restricts period to daily | weekly', () => {
    const period = getTableConfig(trendingEntries).columns.find(
      (column) => column.name === 'period',
    );
    expect(period?.enumValues).toEqual(['daily', 'weekly']);
  });
});

describe('subscribers', () => {
  it('defines the subscribers table with the expected columns', () => {
    const cfg = getTableConfig(subscribers);
    expect(cfg.name).toBe('subscribers');
    expect(columnNames(subscribers)).toEqual([
      'active',
      'created_at',
      'display_name',
      'github_login',
      'github_token_enc',
      'id',
      'last_digest_at',
      'llm_base_url',
      'llm_key_enc',
      'llm_model',
      'preferences',
      'wecom_userid',
    ]);
  });

  it('last_digest_at 为带时区 timestamptz（门控 SQL 的 AT TIME ZONE 比较依赖它）', () => {
    const cfg = getTableConfig(subscribers);
    const lastDigestAt = cfg.columns.find(
      (column) => column.name === 'last_digest_at',
    );
    expect(lastDigestAt?.columnType).toBe('PgTimestamp');
    // withTimezone: true → SQL 类型 timestamptz；裸 timestamp 在 Neon UTC 会话下
    // AT TIME ZONE 'Asia/Shanghai' 日期比较会算错。
    // （withTimezone 是运行时属性，drizzle 公开类型未声明，故断言时收窄。）
    expect(
      (lastDigestAt as unknown as { withTimezone?: boolean } | undefined)
        ?.withTimezone,
    ).toBe(true);
    expect(lastDigestAt?.notNull).toBe(false); // 可空：从未推送过为 NULL
  });

  it('enforces unique(wecom_userid)', () => {
    expect(uniqueCombos(subscribers)).toContain('wecom_userid');
  });

  it('stores preferences as jsonb and github fields as nullable', () => {
    const cfg = getTableConfig(subscribers);
    const preferences = cfg.columns.find(
      (column) => column.name === 'preferences',
    );
    expect(preferences?.columnType).toBe('PgJsonb');

    const githubLogin = cfg.columns.find(
      (column) => column.name === 'github_login',
    );
    const githubTokenEnc = cfg.columns.find(
      (column) => column.name === 'github_token_enc',
    );
    expect(githubLogin?.notNull).toBe(false);
    expect(githubTokenEnc?.notNull).toBe(false);
  });
});

describe('email_subscribers', () => {
  it('defines the email_subscribers table with the expected columns', () => {
    const cfg = getTableConfig(emailSubscribers);
    expect(cfg.name).toBe('email_subscribers');
    expect(columnNames(emailSubscribers)).toEqual([
      'active',
      'confirm_sent_at',
      'confirm_token',
      'confirmed',
      'confirmed_at',
      'consecutive_failures',
      'created_at',
      'email',
      'id',
      'last_sent_at',
      'preferences',
      'unsub_token',
    ]);
  });

  it('enforces unique(email) 与 unique(unsub_token)', () => {
    expect(uniqueCombos(emailSubscribers)).toContain('email');
    expect(uniqueCombos(emailSubscribers)).toContain('unsub_token');
  });

  it('last_sent_at / confirm_sent_at 为带时区 timestamptz', () => {
    const cfg = getTableConfig(emailSubscribers);
    for (const name of ['last_sent_at', 'confirm_sent_at']) {
      const column = cfg.columns.find((c) => c.name === name);
      expect(column?.columnType).toBe('PgTimestamp');
      expect(
        (column as unknown as { withTimezone?: boolean } | undefined)
          ?.withTimezone,
      ).toBe(true);
      expect(column?.notNull).toBe(false);
    }
  });

  it('confirm_token 可空（确认后置 NULL），unsub_token 必填', () => {
    const cfg = getTableConfig(emailSubscribers);
    expect(
      cfg.columns.find((column) => column.name === 'confirm_token')?.notNull,
    ).toBe(false);
    expect(
      cfg.columns.find((column) => column.name === 'unsub_token')?.notNull,
    ).toBe(true);
  });

  it('stores preferences as jsonb and defaults to the 09:00/每天/15 条 profile', () => {
    const preferences = getTableConfig(emailSubscribers).columns.find(
      (column) => column.name === 'preferences',
    );
    expect(preferences?.columnType).toBe('PgJsonb');
    expect(preferences?.notNull).toBe(true);
    // 默认值以 sql 片段形式存储（与 subscribers.preferences 同风格），
    // 因此序列化后按字段名/取值断言。
    const def = JSON.stringify(preferences?.default);
    expect(def).toContain('pushTime');
    expect(def).toContain('09:00');
    expect(def).toContain('intervalDays');
    expect(def).toContain('digestCount');
    expect(def).toContain('15');
  });

  it('confirmed 默认 false、active 默认 true、consecutive_failures 默认 0', () => {
    const cfg = getTableConfig(emailSubscribers);
    expect(
      cfg.columns.find((column) => column.name === 'confirmed')?.default,
    ).toBe(false);
    expect(cfg.columns.find((column) => column.name === 'active')?.default).toBe(
      true,
    );
    expect(
      cfg.columns.find((column) => column.name === 'consecutive_failures')
        ?.default,
    ).toBe(0);
  });
});

describe('favorites', () => {
  it('defines the favorites table with the expected columns', () => {
    expect(getTableConfig(favorites).name).toBe('favorites');
    expect(columnNames(favorites)).toEqual([
      'created_at',
      'full_name',
      'id',
      'starred_on_github',
      'wecom_userid',
    ]);
  });

  it('enforces unique(wecom_userid, full_name)', () => {
    expect(uniqueCombos(favorites)).toContain('full_name,wecom_userid');
  });
});

describe('search_caches', () => {
  it('defines the search_caches table with results stored as jsonb', () => {
    expect(getTableConfig(searchCaches).name).toBe('search_caches');
    expect(columnNames(searchCaches)).toEqual([
      'created_at',
      'id',
      'results',
      'wecom_userid',
    ]);
    const results = getTableConfig(searchCaches).columns.find(
      (column) => column.name === 'results',
    );
    expect(results?.columnType).toBe('PgJsonb');
  });
});

describe('kv_cache', () => {
  it('defines the kv_cache table with key as primary key', () => {
    const cfg = getTableConfig(kvCache);
    expect(cfg.name).toBe('kv_cache');
    expect(columnNames(kvCache)).toEqual(['expires_at', 'key', 'value']);
    const key = cfg.columns.find((column) => column.name === 'key');
    expect(key?.primary).toBe(true);
  });

  it('stores value as jsonb', () => {
    const value = getTableConfig(kvCache).columns.find(
      (column) => column.name === 'value',
    );
    expect(value?.columnType).toBe('PgJsonb');
  });
});
