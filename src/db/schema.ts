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
      }>()
      .notNull()
      .default(sql`'{"languages":[],"keywords":[]}'`),
    githubLogin: text('github_login'),
    githubTokenEnc: text('github_token_enc'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [unique('subscribers_wecom_userid_unique').on(t.wecomUserid)],
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
