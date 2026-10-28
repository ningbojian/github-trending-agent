import { describe, expect, it } from 'vitest';
import {
  classifyAudit,
  maskDsn,
  normalizeColumnType,
  type RelationRow,
} from '../src/db/audit';

/**
 * 库污染审计的纯函数层。
 *
 * 这里钉的不是「脚本能跑」，而是**判定逻辑**——审计说「干净」才有人敢信，
 * 所以每条判定都要有明确的反例：外来表有数据必须报出来，我们的表缺一列
 * 也必须报出来，两者不能糊成一句「库脏了」。
 */

const EXPECTED = [
  'repos',
  'trending_entries',
  'subscribers',
  'email_subscribers',
  'favorites',
  'search_caches',
  'kv_cache',
  'agent_runs',
  'tool_calls',
];

function rel(
  name: string,
  overrides: Partial<RelationRow> = {},
): RelationRow {
  return {
    schema: 'public',
    name,
    kind: 'r',
    estimatedRows: 0,
    oid: 20000,
    owner: 'neondb_owner',
    ...overrides,
  };
}

/** 一个完全不干净的基线：9 张期望表都在、全是空表。 */
function cleanRelations(): RelationRow[] {
  return EXPECTED.map((name, index) => rel(name, { oid: 20000 + index }));
}

const CLEAN_INPUT = {
  relations: cleanRelations(),
  ledger: [
    { id: 1, hash: 'a', createdAt: 1792599299604 },
    { id: 2, hash: 'b', createdAt: 1792867600386 },
    { id: 3, hash: 'c', createdAt: 1792900000000 },
    { id: 4, hash: 'd', createdAt: 1793000000000 },
    { id: 5, hash: 'e', createdAt: 1793200000002 },
  ],
  expectedTables: EXPECTED,
  expectedLedgerCount: 5,
  expectedLedgerMaxWhen: 1793200000002,
  columnDrift: [],
};

describe('classifyAudit — CLEAN', () => {
  it('9 张表齐、账本 5 行且 max when 一致、无漂移 → CLEAN', () => {
    const report = classifyAudit(CLEAN_INPUT);

    expect(report.verdict).toBe('CLEAN');
    expect(report.extraRelations).toEqual([]);
    expect(report.missingTables).toEqual([]);
    expect(report.ledger.rowCount).toBe(5);
    expect(report.ledger.expectedCount).toBe(5);
    expect(report.ledger.ok).toBe(true);
  });

  it('drizzle schema 里的账本表不算「外来关系」', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [
        ...cleanRelations(),
        rel('__drizzle_migrations', { schema: 'drizzle', estimatedRows: 5 }),
      ],
    });

    expect(report.verdict).toBe('CLEAN');
    expect(report.extraRelations).toEqual([]);
  });

  it('自家表的序列（<表名>_id_seq）不算外来关系——否则干净库也会被判成有污染', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [
        ...cleanRelations(),
        ...EXPECTED.map((table, index) =>
          rel(`${table}_id_seq`, { kind: 'S' as const, oid: 21000 + index }),
        ),
        rel('__drizzle_migrations_id_seq', { schema: 'drizzle', kind: 'S', oid: 21999 }),
      ],
    });

    expect(report.verdict).toBe('CLEAN');
    expect(report.extraRelations).toEqual([]);
    expect(report.otherSequences).toEqual([]);
  });

  it('外来序列单独列出来，但不影响判定（序列存不下数据）', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [...cleanRelations(), rel('legacy_seq', { kind: 'S', oid: 22000 })],
    });

    expect(report.verdict).toBe('CLEAN');
    expect(report.otherSequences.map((r) => r.name)).toEqual(['legacy_seq']);
  });
});

describe('classifyAudit — EXTRA_EMPTY', () => {
  it('有外来表但全空 → EXTRA_EMPTY', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [
        ...cleanRelations(),
        rel('legacy_users', { oid: 30000, estimatedRows: 0 }),
      ],
    });

    expect(report.verdict).toBe('EXTRA_EMPTY');
    expect(report.extraRelations.map((r) => r.name)).toEqual(['legacy_users']);
  });

  it('外来视图也算外来关系', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [...cleanRelations(), rel('legacy_view', { kind: 'v', oid: 30001 })],
    });

    expect(report.verdict).toBe('EXTRA_EMPTY');
  });

  it('非 public schema 下的外来表也算外来关系', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [
        ...cleanRelations(),
        rel('users', { schema: 'app', oid: 30002, estimatedRows: 0 }),
      ],
    });

    expect(report.verdict).toBe('EXTRA_EMPTY');
    expect(report.extraRelations[0]?.schema).toBe('app');
  });
});

describe('classifyAudit — EXTRA_WITH_DATA', () => {
  it('外来表有数据 → EXTRA_WITH_DATA（压过 EXTRA_EMPTY）', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [
        ...cleanRelations(),
        rel('legacy_empty', { oid: 30000, estimatedRows: 0 }),
        rel('legacy_users', { oid: 30001, estimatedRows: 1204 }),
      ],
    });

    expect(report.verdict).toBe('EXTRA_WITH_DATA');
    expect(report.extraRelations.map((r) => r.name).sort()).toEqual([
      'legacy_empty',
      'legacy_users',
    ]);
  });

  it('单个外来行也算有数据（0 vs 1 是「有没有用」的分界）', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [...cleanRelations(), rel('probe', { oid: 30000, estimatedRows: 1 })],
    });

    expect(report.verdict).toBe('EXTRA_WITH_DATA');
  });
});

describe('classifyAudit — MISSING_OR_ALTERED', () => {
  it('期望的表缺失 → MISSING_OR_ALTERED（压过所有 EXTRA_*）', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: [
        ...cleanRelations().filter((r) => r.name !== 'tool_calls'),
        rel('legacy_users', { oid: 30000, estimatedRows: 999 }),
      ],
    });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
    expect(report.missingTables).toEqual(['tool_calls']);
    // 外来对象仍然要报出来——它可能就是「我们的表为什么没了」的原因。
    expect(report.extraRelations.map((r) => r.name)).toEqual(['legacy_users']);
  });

  it('列漂移 → MISSING_OR_ALTERED', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      columnDrift: [
        {
          table: 'subscribers',
          column: 'last_digest_at',
          expected: 'timestamp with time zone',
          actual: 'timestamp without time zone',
        },
      ],
    });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
    expect(report.columnDrift).toHaveLength(1);
  });

  it('期望表里多出来的列也算漂移', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      columnDrift: [
        { table: 'repos', column: 'legacy_id', expected: null, actual: 'integer' },
      ],
    });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
  });

  it('账本行数少于 journal 条数 → MISSING_OR_ALTERED', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      ledger: CLEAN_INPUT.ledger.slice(0, 4),
    });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
    expect(report.ledger.ok).toBe(false);
    expect(report.ledger.rowCount).toBe(4);
  });

  it('账本行数对但 max when 落后于 journal → MISSING_OR_ALTERED', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      ledger: CLEAN_INPUT.ledger.map((row, index) =>
        index === 4 ? { ...row, createdAt: 1790000000000 } : row,
      ),
    });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
    expect(report.ledger.ok).toBe(false);
  });

  it('账本表不存在（0 行且 journal 有 5 条）→ MISSING_OR_ALTERED', () => {
    const report = classifyAudit({ ...CLEAN_INPUT, ledger: [] });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
    expect(report.ledger.rowCount).toBe(0);
  });
});

describe('classifyAudit — INCONCLUSIVE', () => {
  it('必要检查跑失败 → 不许说 CLEAN', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      failedChecks: [{ name: 'drift', reason: 'insufficient_privilege' }],
    });

    expect(report.verdict).toBe('INCONCLUSIVE');
    expect(report.failedChecks).toHaveLength(1);
  });

  it('已确认我们自己的表被动过时，未跑完的检查不降级结论', () => {
    const report = classifyAudit({
      ...CLEAN_INPUT,
      relations: cleanRelations().filter((r) => r.name !== 'repos'),
      failedChecks: [{ name: 'drift', reason: 'timeout' }],
    });

    expect(report.verdict).toBe('MISSING_OR_ALTERED');
  });

  it('没有失败检查时 failedChecks 为空数组（调用方不必判 undefined）', () => {
    expect(classifyAudit(CLEAN_INPUT).failedChecks).toEqual([]);
  });
});

describe('maskDsn', () => {
  it('只保留 host 与库名，去掉用户名、密码、参数', () => {
    expect(
      maskDsn(
        'postgresql://neondb_owner:npg_secret@ep-young-credit-b5l33dh4-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toBe('ep-young-credit-b5l33dh4-pooler.c-7.us-east-2.aws.neon.tech/neondb');
  });

  it('密码里带 @ 也不能泄漏（取最后一个 @ 之后）', () => {
    expect(maskDsn('postgresql://u:p@ss@host:5432/db')).toBe('host/db');
  });

  it('没有路径时只回 host', () => {
    expect(maskDsn('postgres://user:pw@host:5432')).toBe('host');
  });

  it('无法解析时回显占位符，绝不回显原串', () => {
    expect(maskDsn('not-a-dsn')).toBe('(无法解析的连接串)');
    expect(maskDsn('')).toBe('(无法解析的连接串)');
  });

  it('缺参数时也不抛', () => {
    expect(() => maskDsn('postgresql://')).not.toThrow();
  });
});

describe('normalizeColumnType', () => {
  it('serial 与 integer + nextval 视为同一列', () => {
    expect(normalizeColumnType('serial')).toBe(normalizeColumnType('integer'));
  });

  it('bigserial 与 bigint 视为同一列', () => {
    expect(normalizeColumnType('bigserial')).toBe(normalizeColumnType('bigint'));
  });

  it('timestamp 是 timestamp without time zone 的缩写（snapshot 写 timestamp，目录写全称）', () => {
    expect(normalizeColumnType('timestamp')).toBe(
      normalizeColumnType('timestamp without time zone'),
    );
  });

  it('timestamp 与 timestamptz 不归一（那是真差异）', () => {
    expect(normalizeColumnType('timestamp')).not.toBe(
      normalizeColumnType('timestamp with time zone'),
    );
  });

  it('大小写与多余空白不敏感', () => {
    expect(normalizeColumnType('  TIMESTAMP   WITH TIME ZONE ')).toBe(
      normalizeColumnType('timestamp with time zone'),
    );
  });

  it('text/varchar 与 character varying 归一（PG 的别名）', () => {
    expect(normalizeColumnType('varchar')).toBe(normalizeColumnType('character varying'));
  });
});
