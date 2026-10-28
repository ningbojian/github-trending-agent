/**
 * 生产库污染审计的纯函数层：不碰数据库、不读 env、不打印。
 *
 * 为什么要有这一层：审计说「干净」时才有人敢信，所以判定逻辑必须能被
 * 单测逐条钉死——外来表有数据要报出来，我们自己的表缺一列也要报出来，
 * 两者不能糊成一句「库脏了」。外壳（`scripts/db-audit.ts`）只负责跑
 * 查询、把结果喂进来、把报告打出去。
 *
 * 两个判定方向必须分开讲，这是本模块最重要的区分：
 * - `MISSING_OR_ALTERED`：**我们自己的东西**被动过（表没了、列改了、迁移账本落后）；
 * - `EXTRA_*`：**别人用过这个库**（多出不属于本项目的关系）。
 * 前者是故障，后者是历史遗留，处理方式完全不同。
 */

/** 一个 relation（表/分区/视图/物化视图/序列）。 */
export interface RelationRow {
  schema: string;
  name: string;
  kind: 'r' | 'p' | 'v' | 'm' | 'S';
  /** 估算行数：我们自己用精确 count，外来表用 `pg_stat_user_tables.n_live_tup` 或 bounded count。 */
  estimatedRows: number;
  /** `pg_class.oid`：仅用于判断建表先后（建得比 `repos` 早 → 不可能是我们建的）。 */
  oid: number;
  owner: string;
}

/** `drizzle.__drizzle_migrations` 的一行。 */
export interface LedgerRow {
  id: number;
  hash: string;
  createdAt: number;
}

/** 一列的漂移：`expected` 为空表示这列不该存在；`actual` 为空表示这列缺失。 */
export interface ColumnDrift {
  table: string;
  column: string;
  expected: string | null;
  actual: string | null;
}

export interface AuditInput {
  relations: RelationRow[];
  ledger: LedgerRow[];
  /** 期望的 public 表名（来自最新 drizzle snapshot）。 */
  expectedTables: string[];
  /** `drizzle/meta/_journal.json` 的 entries 数。 */
  expectedLedgerCount: number;
  /** journal 最后一条的 `when`。 */
  expectedLedgerMaxWhen: number;
  columnDrift: ColumnDrift[];
  /** 跑失败的必要检查；非空即无法给出可信结论。 */
  failedChecks?: FailedCheck[];
}

export type Verdict =
  | 'CLEAN'
  | 'EXTRA_EMPTY'
  | 'EXTRA_WITH_DATA'
  | 'MISSING_OR_ALTERED'
  | 'INCONCLUSIVE';

/**
 * 一项检查跑失败了（权限不足、超时、表不存在）。
 *
 * 为什么单列 `INCONCLUSIVE` 而不是把失败当成「没发现问题」：这个工具的
 * 全部价值在于「它说干净，你才敢信」。如果某条查询失败被静默当成空结果，
 * 报告就会在**没真正检查**的情况下说 CLEAN——比不检查更糟，因为它给了
 * 一个假的保证。
 */
export interface FailedCheck {
  name: string;
  reason: string;
}

export interface LedgerStatus {
  rowCount: number;
  expectedCount: number;
  maxCreatedAt: number | null;
  expectedMaxWhen: number;
  ok: boolean;
}

export interface AuditReport {
  verdict: Verdict;
  /** 不属于本项目的关系（含非 public schema 下的）。序列不在这里。 */
  extraRelations: RelationRow[];
  /**
   * 不属于本项目的序列（单独列，不参与判定）。
   *
   * 为什么序列不能进 extraRelations：每个 `serial` 列都会自动建一个
   * `<表名>_id_seq`，它们合法但不叫「表名」，若一起判定，一个**完全干净**
   * 的库也会因为 6 个自家序列被判成 `EXTRA_EMPTY`。序列也存不下数据，
   * 用「有没有数据」区分污染程度对它没有意义。
   */
  otherSequences: RelationRow[];
  /** 期望存在但库里没有的表。 */
  missingTables: string[];
  columnDrift: ColumnDrift[];
  ledger: LedgerStatus;
  /** 跑失败的检查（`INCONCLUSIVE` 时非空）。 */
  failedChecks: FailedCheck[];
}

/**
 * 不算「外来关系」的 schema：drizzle 自己的迁移账本。
 * 其他任何 schema 下的关系都会被当成外来对象报出来。
 */
const OWN_SCHEMAS = new Set(['drizzle']);

function isExpected(
  relation: RelationRow,
  expectedTables: string[],
): boolean {
  if (OWN_SCHEMAS.has(relation.schema)) {
    return true;
  }
  return relation.schema === 'public' && expectedTables.includes(relation.name);
}

/** `serial` 列自动建的序列：`<表名>_id_seq`，属于我们自己。 */
function isOwnSequence(name: string, expectedTables: string[]): boolean {
  return expectedTables.some((table) => name === `${table}_id_seq`);
}

function ledgerStatus(input: AuditInput): LedgerStatus {
  const maxCreatedAt =
    input.ledger.length === 0
      ? null
      : Math.max(...input.ledger.map((row) => row.createdAt));
  const countOk = input.ledger.length === input.expectedLedgerCount;
  // max when 只在行数对的前提下才有意义：行数少的时候 max 必然也对不上，
  // 但报错原因要说「少了几行」，不是「时间戳不对」。
  const whenOk = countOk && maxCreatedAt === input.expectedLedgerMaxWhen;
  return {
    rowCount: input.ledger.length,
    expectedCount: input.expectedLedgerCount,
    maxCreatedAt,
    expectedMaxWhen: input.expectedLedgerMaxWhen,
    ok: countOk && whenOk,
  };
}

/**
 * 判定一张表是「干净」还是「被动过」。优先级从重到轻。
 *
 * 顺序不是随便排的：`MISSING_OR_ALTERED` 代表我们自己的东西出了问题，
 * 比「多出别人的表」严重得多——即使同时存在外来对象，也要先报我们自己的。
 */
export function classifyAudit(input: AuditInput): AuditReport {
  const ledger = ledgerStatus(input);

  const extraRelations: RelationRow[] = [];
  const otherSequences: RelationRow[] = [];
  for (const relation of input.relations) {
    if (isExpected(relation, input.expectedTables)) {
      continue;
    }
    if (relation.kind === 'S') {
      // 自家 serial 序列忽略；外来序列记下来但不参与判定（存不下数据）。
      if (!isOwnSequence(relation.name, input.expectedTables)) {
        otherSequences.push(relation);
      }
      continue;
    }
    extraRelations.push(relation);
  }

  const presentPublic = new Set(
    input.relations
      .filter((relation) => relation.schema === 'public')
      .map((relation) => relation.name),
  );
  const missingTables = input.expectedTables.filter(
    (table) => !presentPublic.has(table),
  );

  const altered =
    missingTables.length > 0 || input.columnDrift.length > 0 || !ledger.ok;

  const failedChecks = input.failedChecks ?? [];

  let verdict: Verdict;
  if (altered) {
    // 已经确认我们自己的东西被动过：即使还有检查没跑完，结论也成立，不必降级。
    verdict = 'MISSING_OR_ALTERED';
  } else if (failedChecks.length > 0) {
    // 必要的检查没跑成 → 不能声称干净。宁可说「查不清」，也不给假保证。
    verdict = 'INCONCLUSIVE';
  } else if (extraRelations.length === 0) {
    verdict = 'CLEAN';
  } else if (extraRelations.some((relation) => relation.estimatedRows > 0)) {
    verdict = 'EXTRA_WITH_DATA';
  } else {
    verdict = 'EXTRA_EMPTY';
  }

  return {
    verdict,
    extraRelations,
    otherSequences,
    missingTables,
    columnDrift: input.columnDrift,
    ledger,
    failedChecks,
  };
}

/**
 * 把连接串打码成 `host/db`，用于报告与日志。
 *
 * 审计报告会被人复制粘贴（贴进 issue、发给同事），连接串里有用户名和密码，
 * 绝不能出现在输出里。解析失败时回占位符而不是原串——宁可少一条信息，
 * 也不能赌「这次解析是对的」。
 */
export function maskDsn(dsn: string): string {
  const placeholder = '(无法解析的连接串)';
  const withoutScheme = dsn.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (withoutScheme === '' || withoutScheme === dsn.trim()) {
    return placeholder;
  }
  // 密码里可能含 `@`：取最后一个 `@`，后面的才是 host。
  const at = withoutScheme.lastIndexOf('@');
  const hostPart = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  if (hostPart === '') {
    return placeholder;
  }
  const slash = hostPart.indexOf('/');
  if (slash === -1) {
    // 只有 host[:port]：去掉端口，只回 host。
    const host = hostPart.split('?')[0] ?? '';
    const hostname = host.split(':')[0] ?? '';
    return hostname === '' ? placeholder : hostname;
  }
  const hostname = (hostPart.slice(0, slash).split(':')[0] ?? '').trim();
  const database = (hostPart.slice(slash + 1).split('?')[0] ?? '').trim();
  if (hostname === '') {
    return placeholder;
  }
  return database === '' ? hostname : `${hostname}/${database}`;
}

/**
 * 列类型归一：只抹平「写法不同、语义相同」的差异。
 *
 * - drizzle snapshot 里写 `serial`，Postgres 目录里是 `integer` + `nextval(...)`
 *   默认值——这是同一列，不能报漂移；
 * - snapshot 写 `timestamp`，`format_type` 回 `timestamp without time zone`——
 *   同一个类型；`timestamp with time zone` 是**另一回事**，必须区分（本项目
 *   踩过：`last_digest_at` 必须是 timestamptz，否则日期门控算错）；
 * - `varchar` 与 `character varying` 是 PG 别名。
 */
export function normalizeColumnType(type: string): string {
  const normalized = type.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'serial') return 'integer';
  if (normalized === 'bigserial') return 'bigint';
  if (normalized === 'smallserial') return 'smallint';
  if (normalized === 'varchar') return 'character varying';
  // `timestamp` 是 `timestamp without time zone` 的缩写。不归一这一条会让
  // 一个完全正常的库被报成「5 列漂移」——假警比漏报更能毁掉工具的可信度。
  if (normalized === 'timestamp') return 'timestamp without time zone';
  return normalized;
}
