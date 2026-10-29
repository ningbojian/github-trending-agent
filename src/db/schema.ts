import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
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
    /**
     * 用户自备的 LLM（互动专用）：接口地址 / 模型名 / 加密后的 Key。
     * 每日推送仍走运营方 key；互动（解析搜索意图、生成中文简介）用这三个字段。
     * 三列同时为空 = 未配置 → 互动退回规则解析 + 共享缓存，零 token。
     */
    llmBaseUrl: text('llm_base_url'),
    llmModel: text('llm_model'),
    llmKeyEnc: text('llm_key_enc'),
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
 * 用户主动跟踪的 GitHub 仓库/作者（第二阶段）。
 *
 * - `identifier` 是规范化后的主键（仓库 `owner/repo` 小写、作者 `owner` 小写）；
 * - `cursor` 保存上次检查到的位置（release tag、上次 star 数等），
 *   只在消息发送成功后才推进，发送失败留给下一个 tick 重试；
 * - 这张表把用户与仓库关联起来，**绝不进入聚合指标/共享缓存**；
 *   退订时删除该用户的行。
 */
export interface TrackedCursor {
  releaseTag?: string;
  releasePublishedAt?: string;
  lastStars?: number;
  lastCheckedAt?: string;
  archived?: boolean;
}

export const trackedItems = pgTable(
  'tracked_items',
  {
    id: serial('id').primaryKey(),
    wecomUserid: text('wecom_userid').notNull(),
    source: text('source', { enum: ['github'] }).notNull().default('github'),
    kind: text('kind', { enum: ['repo', 'author'] }).notNull().default('repo'),
    identifier: text('identifier').notNull(),
    displayName: text('display_name').notNull(),
    cursor: jsonb('cursor').$type<TrackedCursor>().notNull().default(sql`'{}'`),
    active: boolean('active').notNull().default(true),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastChangeAt: timestamp('last_change_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tracked_items_user_source_kind_identifier_unique').on(
      t.wecomUserid,
      t.source,
      t.kind,
      t.identifier,
    ),
    index('tracked_items_active_checked_idx').on(t.active, t.lastCheckedAt),
  ],
);

/**
 * 多源条目（Hugging Face / GitHub Search / HN / Lobsters）。
 *
 * 只存公开数据，不含 userid；唯一键 (source, source_id, captured_date)
 * 让同一天重复抓取幂等。观察层按 source 取最近若干天的指标变化。
 */
export const sourceItems = pgTable(
  'source_items',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    itemType: text('item_type').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    author: text('author'),
    description: text('description'),
    topics: jsonb('topics').$type<string[]>().notNull().default(sql`'[]'`),
    metrics: jsonb('metrics')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'`),
    raw: jsonb('raw'),
    capturedDate: date('captured_date').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('source_items_source_id_date_unique').on(
      t.source,
      t.sourceId,
      t.capturedDate,
    ),
    index('source_items_source_date_idx').on(t.source, t.capturedDate),
    index('source_items_source_item_date_idx').on(
      t.source,
      t.sourceId,
      t.capturedDate,
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

/**
 * 请求级运行记录（正式表，取代 kv_cache 里的 trace）。
 *
 * 为什么现在建表：kv_cache 适合「有 TTL、按 key 取一条」的短命数据；trace
 * 要按时间倒排、按 kind 聚合、算 p50/p95，还要和 tool_calls 关联，这些正是
 * SQL 的活。kv 版本作为降级路径保留：写正式表失败时仍然落一行 kv。
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    /** 与 tool_calls.run_id 对应；一次入站消息 / 一次推送一个。 */
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['text', 'event', 'push', 'other'] }).notNull(),
    userid: text('userid').notNull(),
    /** 用户原话（已截断），仅排障用。 */
    text: text('text').notNull().default(''),
    ok: boolean('ok').notNull(),
    totalMs: integer('total_ms').notNull(),
    /** 本次请求累计的模型 token（可能多次调用），用于成本看板。 */
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    steps: jsonb('steps')
      .$type<Array<{ ms: number; name: string; detail?: string }>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_runs_created_at_idx').on(t.createdAt),
    index('agent_runs_kind_created_at_idx').on(t.kind, t.createdAt),
    index('agent_runs_user_created_at_idx').on(t.userid, t.createdAt),
  ],
);

/**
 * 工具调用流水：只存参数哈希，不存原文（参数里可能带用户输入）。
 * 不设外键：工具调用发生在 agent_runs 落库之前，外键会把正常流程卡死；
 * 极少数孤儿行由 30 天清理兜底。
 */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id').notNull(),
    tool: text('tool').notNull(),
    argsHash: text('args_hash').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_calls_run_id_idx').on(t.runId),
    index('tool_calls_created_at_idx').on(t.createdAt),
  ],
);
