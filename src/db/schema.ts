import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * 仓库主数据（trending 页抓取 + GitHub API 补全）。
 */
export const repos = pgTable('repos', {
  fullName: text('full_name').primaryKey(),
  name: text('name').notNull(),
  owner: text('owner').notNull(),
  description: text('description'),
  language: text('language'),
  topics: jsonb('topics').$type<string[]>().notNull(),
  stars: integer('stars').notNull(),
  htmlUrl: text('html_url').notNull(),
});

/**
 * 热榜条目快照：同一仓库可按日期/周期/语言多次出现。
 * language 用 'all' 表示"全部语言"榜，保证唯一约束可用。
 */
export const trendingEntries = pgTable(
  'trending_entries',
  {
    id: serial('id').primaryKey(),
    fullName: text('full_name')
      .notNull()
      .references(() => repos.fullName, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    period: text('period', { enum: ['daily', 'weekly'] }).notNull(),
    language: text('language').notNull(),
    rank: integer('rank').notNull(),
    starsAtCapture: integer('stars_at_capture').notNull(),
    starsDelta: integer('stars_delta').notNull(),
    isNew: boolean('is_new').notNull(),
    source: text('source').notNull(),
  },
  (t) => [
    unique('trending_entries_date_period_language_full_name_unique').on(
      t.date,
      t.period,
      t.language,
      t.fullName,
    ),
  ],
);

/**
 * 订阅者（企业微信成员）。
 */
export const subscribers = pgTable(
  'subscribers',
  {
    id: serial('id').primaryKey(),
    wecomUserid: text('wecom_userid').notNull(),
    displayName: text('display_name').notNull(),
    preferences: jsonb('preferences')
      .$type<{
        languages: string[];
        keywords: string[];
        digestCount?: number;
        /** 每日推送时间「HH:MM」（北京时间；缺省按 09:00）。 */
        pushTime?: string;
        /** 推送间隔天数 1–30（缺省 1 = 每天）。 */
        intervalDays?: number;
      }>()
      .notNull()
      .default(sql`'{"languages":[],"keywords":[]}'`),
    githubLogin: text('github_login'),
    githubTokenEnc: text('github_token_enc'),
    active: boolean('active').notNull().default(true),
    // timestamptz（withTimezone: true）：门控 SQL 用 AT TIME ZONE 'Asia/Shanghai'
    // 做北京时间日期比较——裸 timestamp 在 Neon 的 UTC 会话时区下会算错日期。
    lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [unique('subscribers_wecom_userid_unique').on(t.wecomUserid)],
);

/**
 * 邮箱订阅者（备用触达通道，与企微成员完全独立）。
 * - email 去空白、小写化后唯一
 * - confirmToken 一次性（确认后置 null）；unsubToken 长期有效（设置/退订链接凭证）
 * - preferences 与企微共用同一套字段语义（digestCount 默认 15，推送窗口 09:00–17:00 整点）
 * - lastSentAt 用 timestamptz：日期比较依赖 AT TIME ZONE 'Asia/Shanghai'
 */
export const emailSubscribers = pgTable(
  'email_subscribers',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    confirmToken: text('confirm_token'),
    unsubToken: text('unsub_token').notNull(),
    confirmed: boolean('confirmed').notNull().default(false),
    active: boolean('active').notNull().default(true),
    preferences: jsonb('preferences')
      .$type<{
        pushTime: string;
        intervalDays: number;
        digestCount: number;
        languages: string[];
        keywords: string[];
      }>()
      .notNull()
      .default(
        sql`'{"pushTime":"09:00","intervalDays":1,"digestCount":15,"languages":[],"keywords":[]}'`,
      ),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    confirmSentAt: timestamp('confirm_sent_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [
    unique('email_subscribers_email_unique').on(t.email),
    unique('email_subscribers_unsub_token_unique').on(t.unsubToken),
  ],
);

/**
 * 收藏（与用户 GitHub star 双向同步，starred_on_github 记录同步状态）。
 */
export const favorites = pgTable(
  'favorites',
  {
    id: serial('id').primaryKey(),
    wecomUserid: text('wecom_userid').notNull(),
    fullName: text('full_name').notNull(),
    starredOnGithub: boolean('starred_on_github').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('favorites_wecom_userid_full_name_unique').on(
      t.wecomUserid,
      t.fullName,
    ),
  ],
);

/**
 * 最近一次检索结果缓存，供"收藏 N"按序号引用。
 */
export const searchCaches = pgTable('search_caches', {
  id: serial('id').primaryKey(),
  wecomUserid: text('wecom_userid').notNull(),
  results: jsonb('results').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/**
 * KV 缓存（存企业微信 access_token 等短命数据）。
 */
export const kvCache = pgTable('kv_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});
