import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import {
  classifyAudit,
  maskDsn,
  normalizeColumnType,
  type AuditReport,
  type ColumnDrift,
  type FailedCheck,
  type LedgerRow,
  type RelationRow,
} from '../src/db/audit.js';

/**
 * 生产库污染审计：一条命令看清这个 Neon 库是不是只有我们。
 *
 * 全程只读——没有一条 INSERT/UPDATE/DELETE/DDL。审计本身绝不能改变被审计
 * 对象的状态，否则「查完还是干净的吗」就永远说不清了。
 *
 * 为什么不走 `src/db/client.ts`：那个模块导入即触发 `src/config.ts` 的全量
 * zod 校验，缺任一必填变量直接抛（本地 `.env` 里大部分是占位符）。审计只需要
 * 一个连接串，没必要为了建连去满足整套业务配置。
 *
 * 逐项容错：托管环境对 `pg_database`、`pg_stat_activity` 的权限各不相同，
 * 某一项查不到就标「无法检查」，不能让整份报告失败——那会把「权限不足」
 * 伪装成「库有问题」。
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const META_DIR = join(REPO_ROOT, 'drizzle', 'meta');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface SnapshotColumn {
  name: string;
  type: string;
  notNull?: boolean;
}

interface SnapshotTable {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
}

interface Snapshot {
  tables: Record<string, SnapshotTable>;
}

/** 标记「某项无法检查」而不是编一个假值。 */
class Unavailable {
  constructor(readonly reason: string) {}
}

function asUnavailable(err: unknown): Unavailable {
  return new Unavailable(err instanceof Error ? err.message : String(err));
}

/** 读最新一份 snapshot（文件名前缀最大的那个）。 */
function loadLatestSnapshot(): Snapshot {
  const files = readdirSync(META_DIR)
    .filter((name) => name.endsWith('_snapshot.json'))
    .sort();
  const latest = files.at(-1);
  if (latest === undefined) {
    throw new Error(`drizzle/meta 下没有 *_snapshot.json`);
  }
  return JSON.parse(readFileSync(join(META_DIR, latest), 'utf8')) as Snapshot;
}

function loadJournal(): JournalEntry[] {
  const raw = readFileSync(join(META_DIR, '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** `public.subscribers` → `subscribers`；非 public 的表不参与期望集合。 */
function expectedPublicTables(snapshot: Snapshot): string[] {
  return Object.values(snapshot.tables)
    .filter((table) => (table.schema ?? '') === '' || table.schema === 'public')
    .map((table) => table.name)
    .sort();
}

interface LiveColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/** 把 snapshot 的列与 information_schema 的列比对，产出漂移清单。 */
function diffColumns(
  snapshot: Snapshot,
  live: LiveColumn[],
  expectedTables: string[],
): ColumnDrift[] {
  const drift: ColumnDrift[] = [];
  const liveByTable = new Map<string, Map<string, LiveColumn>>();
  for (const column of live) {
    let map = liveByTable.get(column.table_name);
    if (map === undefined) {
      map = new Map();
      liveByTable.set(column.table_name, map);
    }
    map.set(column.column_name, column);
  }

  for (const tableName of expectedTables) {
    const key = Object.keys(snapshot.tables).find(
      (k) => snapshot.tables[k]?.name === tableName,
    );
    const expected = key === undefined ? undefined : snapshot.tables[key];
    if (expected === undefined) continue;
    const actual = liveByTable.get(tableName) ?? new Map<string, LiveColumn>();

    for (const column of Object.values(expected.columns)) {
      const found = actual.get(column.name);
      if (found === undefined) {
        drift.push({
          table: tableName,
          column: column.name,
          expected: column.type,
          actual: null,
        });
        continue;
      }
      if (
        normalizeColumnType(column.type) !== normalizeColumnType(found.data_type)
      ) {
        drift.push({
          table: tableName,
          column: column.name,
          expected: column.type,
          actual: found.data_type,
        });
      }
    }

    const expectedNames = new Set(
      Object.values(expected.columns).map((column) => column.name),
    );
    for (const columnName of actual.keys()) {
      if (!expectedNames.has(columnName)) {
        drift.push({
          table: tableName,
          column: columnName,
          expected: null,
          actual: actual.get(columnName)?.data_type ?? null,
        });
      }
    }
  }

  return drift;
}

const LINE = '─'.repeat(56);

function formatReport(
  report: AuditReport,
  meta: {
    maskedTarget: string;
    database: string;
    user: string;
    schemas: string[];
    prismaLikeHits: string[];
    otherConnections: Array<{ applicationName: string; count: number }>;
    otherDatabases: string[] | null;
    reposOid: number | null;
    ownCounts: Array<{ table: string; rows: number }>;
  },
): string {
  const lines: string[] = [];
  lines.push(LINE);
  lines.push(`数据库审计 · ${meta.maskedTarget}`);
  lines.push(`库: ${meta.database}   用户: ${meta.user}`);
  lines.push(`schema: ${meta.schemas.join(', ')}`);
  lines.push(LINE);

  const badge =
    report.verdict === 'CLEAN'
      ? '✅'
      : report.verdict === 'MISSING_OR_ALTERED'
        ? '❌'
        : report.verdict === 'INCONCLUSIVE'
          ? '❓'
          : '⚠️';
  lines.push(`判定: ${report.verdict} ${badge}`);
  lines.push('');

  if (report.verdict === 'INCONCLUSIVE') {
    lines.push('【有检查没跑成，无法给出干净结论】');
    for (const check of report.failedChecks) {
      lines.push(`  ${check.name}: ${check.reason}`);
    }
    lines.push('');
  }

  if (report.verdict === 'MISSING_OR_ALTERED') {
    lines.push('【我们自己的结构被动过】');
    if (report.missingTables.length > 0) {
      lines.push(`  缺失的表: ${report.missingTables.join(', ')}`);
    }
    if (report.columnDrift.length > 0) {
      lines.push('  列漂移:');
      for (const d of report.columnDrift) {
        lines.push(
          `    ${d.table}.${d.column}: 期望 ${d.expected ?? '(不应存在)'} / 实际 ${d.actual ?? '(缺失)'}`,
        );
      }
    }
    if (!report.ledger.ok) {
      lines.push(
        `  迁移账本: ${report.ledger.rowCount} 行（应为 ${report.ledger.expectedCount}），` +
          `max(created_at)=${report.ledger.maxCreatedAt ?? '(空)'}（应为 ${report.ledger.expectedMaxWhen}）`,
      );
    }
    lines.push('');
  }

  if (report.extraRelations.length > 0) {
    lines.push('【不属于本项目的关系】');
    for (const relation of report.extraRelations) {
      const where = relation.schema === 'public' ? '' : `${relation.schema}.`;
      const rows =
        relation.kind === 'S' ? '序列' : `约 ${relation.estimatedRows} 行`;
      const order =
        meta.reposOid !== null && relation.oid < meta.reposOid
          ? '（建表早于 repos）'
          : '';
      lines.push(
        `  ${where}${relation.name}  ${rows}  oid ${relation.oid}${order}`,
      );
    }
    if (meta.prismaLikeHits.length > 0) {
      lines.push(
        `  ⚑ 检测到其他迁移工具的痕迹: ${meta.prismaLikeHits.join(', ')}`,
      );
    }
    lines.push('');
  }

  if (report.otherSequences.length > 0) {
    lines.push(
      `  （另有 ${report.otherSequences.map((r) => `${r.schema === 'public' ? '' : `${r.schema}.`}${r.name}`).join(', ')} 等外来序列；序列存不下数据，不影响判定）`,
    );
    lines.push('');
  }

  lines.push('明细');
  lines.push(
    `  public 关系: ${report.missingTables.length === 0 ? '全部符合预期' : '有缺失'}`,
  );
  lines.push(
    `  账本: ${report.ledger.rowCount} 行，max=${report.ledger.maxCreatedAt ?? '(空)'}`,
  );
  if (meta.ownCounts.length > 0) {
    lines.push(
      `  行数: ${meta.ownCounts.map((c) => `${c.table}=${c.rows}`).join(', ')}`,
    );
  }
  lines.push(
    `  同库连接: ${meta.otherConnections.length === 0 ? '仅本审计' : meta.otherConnections.map((c) => `${c.applicationName || '(未命名)'}×${c.count}`).join(', ')}`,
  );
  lines.push(
    `  本实例其他库: ${meta.otherDatabases === null ? '无法检查' : meta.otherDatabases.length === 0 ? '无' : meta.otherDatabases.join(', ')}`,
  );
  lines.push(LINE);
  return lines.join('\n');
}

async function main(): Promise<void> {
  // Node ≥22 自带 .env 解析；仓库没有装 dotenv，也不该为一条审计脚本装。
  const dsn = process.env.NEON_DATABASE_URL ?? loadFromDotEnv();
  if (dsn === undefined || dsn === '') {
    process.stderr.write(
      '缺少 NEON_DATABASE_URL。用 `node --env-file=.env` 或先导出该变量。\n',
    );
    process.exitCode = 2;
    return;
  }

  const sql = neon(dsn);
  const snapshot = loadLatestSnapshot();
  const journal = loadJournal();
  const expectedTables = expectedPublicTables(snapshot);
  const lastJournal = journal.at(-1);

  // 1. 身份
  const identity = (await sql`
    select current_database() as db, current_user as usr,
           coalesce(inet_server_addr()::text, '') as addr`,
  )[0] as { db: string; usr: string; addr: string };

  // 2. schema 清单
  const schemaRows = (await sql`
    select nspname from pg_namespace
    where nspname not like 'pg\_%' and nspname <> 'information_schema'
    order by nspname`,
  ) as Array<{ nspname: string }>;

  // 3. 关系清单（不含序列）
  const relationRows = (await sql`
    select n.nspname as schema,
           c.relname as name,
           c.relkind::text as kind,
           coalesce(s.n_live_tup, 0)::int as estimated_rows,
           c.oid::int as oid,
           pg_get_userbyid(c.relowner) as owner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where c.relkind in ('r','p','v','m','S')
      and n.nspname not like 'pg\_%'
      and n.nspname <> 'information_schema'
    order by n.nspname, c.relname`,
  ) as Array<{
    schema: string;
    name: string;
    kind: RelationRow['kind'];
    estimated_rows: number;
    oid: number;
    owner: string;
  }>;

  const relations: RelationRow[] = relationRows.map((row) => ({
    schema: row.schema,
    name: row.name,
    kind: row.kind,
    estimatedRows: row.estimated_rows,
    oid: row.oid,
    owner: row.owner,
  }));

  // 4. 同库连接者（有陌生 application_name 长期连着 = 别的项目还在用）
  let otherConnections: Array<{ applicationName: string; count: number }> = [];
  try {
    const rows = (await sql`
      select coalesce(application_name, '') as app, count(*)::int as count
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
      group by 1 order by 2 desc`,
    ) as Array<{ app: string; count: number }>;
    otherConnections = rows.map((row) => ({
      applicationName: row.app,
      count: row.count,
    }));
  } catch (err) {
    void asUnavailable(err);
  }

  // 5. 本实例其他数据库（权限可能不足）
  let otherDatabases: string[] | null = null;
  try {
    const rows = (await sql`
      select datname from pg_database
      where datname <> current_database() and datistemplate = false
      order by 1`,
    ) as Array<{ datname: string }>;
    otherDatabases = rows.map((row) => row.datname);
  } catch (err) {
    void asUnavailable(err);
  }

  // 6. 外来迁移工具痕迹（一出现就说明别的项目在这个库里跑过迁移）
  const PRISMA_LIKE = [
    '_prisma_migrations',
    'supabase_migrations',
    'schema_migrations',
    'SequelizeMeta',
    'knex_migrations',
    'flyway_schema_history',
    'alembic_version',
    '__EFMigrationsHistory',
  ];
  const presentNames = new Set(relations.map((relation) => relation.name));
  const prismaLikeHits = PRISMA_LIKE.filter((name) => presentNames.has(name));

  // 7. 迁移账本（表可能压根不存在）
  let ledger: LedgerRow[] = [];
  try {
    const rows = (await sql`
      select id, hash, created_at from drizzle.__drizzle_migrations order by id`,
    ) as Array<{ id: number; hash: string; created_at: string | number }>;
    ledger = rows.map((row) => ({
      id: Number(row.id),
      hash: row.hash,
      createdAt: Number(row.created_at),
    }));
  } catch (err) {
    // 账本读不到 → 无法判断迁移是否跑全，必须降级而不是当作「0 行」。
    failedChecks.push({ name: '迁移账本', reason: asUnavailable(err).reason });
  }

  // 8. 我们自己的表精确行数（表小，一条查询搞定）
  let ownCounts: Array<{ table: string; rows: number }> = [];
  try {
    const present = new Set(
      relations
        .filter((relation) => relation.schema === 'public')
        .map((relation) => relation.name),
    );
    const wanted = expectedTables.filter((table) => present.has(table));
    if (wanted.length > 0) {
      const selects = wanted
        .map((table) => `select '${table}' as t, count(*)::int as n from "${table}"`)
        .join(' union all ');
      const rows = (await sql.query(selects)) as Array<{ t: string; n: number }>;
      ownCounts = rows.map((row) => ({ table: row.t, rows: Number(row.n) }));
    }
  } catch (err) {
    void asUnavailable(err);
  }

  // 9. 结构漂移。
  // 这一项失败必须让整份报告降级为 INCONCLUSIVE：读不到列信息时说「没有漂移」，
  // 等于在没检查的情况下给了一个干净保证——比不检查更糟。
  let columnDrift: ColumnDrift[] = [];
  const failedChecks: FailedCheck[] = [];
  try {
    const live = (await sql`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
    ) as LiveColumn[];
    columnDrift = diffColumns(snapshot, live, expectedTables);
  } catch (err) {
    failedChecks.push({ name: '结构漂移（列比对）', reason: asUnavailable(err).reason });
  }

  // 10. 外来关系的 bounded count：只扫 1001 行，回答「有没有数据」即可
  const extrasOf = relations.filter(
    (relation) =>
      relation.kind !== 'S' &&
      !(relation.schema === 'public' && expectedTables.includes(relation.name)) &&
      relation.schema !== 'drizzle',
  );

  const refinedExtras = new Map<string, number>();
  for (const relation of extrasOf) {
    const key = `${relation.schema}.${relation.name}`;
    try {
      const qualified = `"${relation.schema.replace(/"/g, '""')}"."${relation.name.replace(/"/g, '""')}"`;
      const rows = (await sql.query(
        `select count(*)::int as n from (select 1 from ${qualified} limit 1001) q`,
      )) as Array<{ n: number }>;
      refinedExtras.set(key, Number(rows[0]?.n ?? 0));
    } catch {
      refinedExtras.set(key, relation.estimatedRows);
    }
  }
  const relationsWithCounts = relations.map((relation) => {
    const key = `${relation.schema}.${relation.name}`;
    const refined = refinedExtras.get(key);
    return refined === undefined ? relation : { ...relation, estimatedRows: refined };
  });

  const report = classifyAudit({
    relations: relationsWithCounts,
    ledger,
    expectedTables,
    expectedLedgerCount: journal.length,
    expectedLedgerMaxWhen: lastJournal?.when ?? 0,
    columnDrift,
    failedChecks,
  });

  process.stdout.write(
    `${formatReport(report, {
      maskedTarget: maskDsn(dsn),
      database: identity.db,
      user: identity.usr,
      schemas: schemaRows.map((row) => row.nspname),
      prismaLikeHits,
      otherConnections,
      otherDatabases,
      reposOid: relations.find((r) => r.schema === 'public' && r.name === 'repos')?.oid ?? null,
      ownCounts,
    })}\n`,
  );

  process.exitCode =
    report.verdict === 'CLEAN' || report.verdict === 'EXTRA_EMPTY'
      ? 0
      : report.verdict === 'EXTRA_WITH_DATA'
        ? 1
        : 2;
}

/**
 * 没有 `--env-file` 时手工读 `.env`（与 `tmp-db-clear.mjs` 同款，
 * 只取一行，不做完整 dotenv 语义）。
 */
function loadFromDotEnv(): string | undefined {
  try {
    const text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('NEON_DATABASE_URL=')) continue;
      return line.slice('NEON_DATABASE_URL='.length).replace(/^"|"$/g, '');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

main().catch((err: unknown) => {
  process.stderr.write(
    `审计失败：${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 2;
});
