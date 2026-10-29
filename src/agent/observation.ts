import { inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import type { DigestSnapshot } from './digest-snapshot.js';
import { generateObjectSafe } from './llm.js';
import { shanghaiToday } from './time.js';

/**
 * 今日观察：把「今天和过去 7 天有什么不同」写成 2–3 条带仓库证据的中文观察。
 *
 * 为什么单独一层：`abstract.ts` 是一段没有门槛的邮件概览，每天都会重写一遍；
 * 观察必须**讲变化、防重复**——候选全部由代码从 trending_entries 的历史里算出来，
 * 模型只负责把事实写成一句话，数字与仓库都做白名单校验。
 *
 * 历史不能依赖 `digest-snapshot:<date>`：那个缓存只有 24h TTL，第二天就过期。
 * `trending_entries` 才是可靠的 7 天历史。
 */

export type ObservationKind =
  | 'new-entrant'
  | 'acceleration'
  | 'streak'
  | 'theme-shift'
  | 'source-shift';

export interface ObservationFactRow {
  fullName: string;
  language: string | null;
  topics: string[];
  stars: number;
  deltaToday: number;
  deltaPrev: number | null;
  prevRank: number | null;
  rankToday: number | null;
  daysOnList: number;
  firstSeenDate: string;
  isNew: boolean;
  /** 窗口内出现过的不同日期数；<2 时禁用「新上榜/加速/连续在榜」。 */
  historyDepth?: number;
}

export interface ThemeCountRow {
  theme: string;
  kind: 'language' | 'topic';
  date: string;
  count: number;
}

export interface ThemeStat {
  theme: string;
  kind: 'language' | 'topic';
  today: number;
  trailingAvg: number;
  ratio: number;
}

export interface ObservationCandidate {
  kind: ObservationKind;
  signature: string;
  mainRepo: string | null;
  evidence: string[];
  facts: string;
  score: number;
  theme?: string;
}

export interface ObservationLine {
  kind: ObservationKind;
  claim: string;
  evidence: string[];
  signature: string;
  theme?: string;
}

export interface ObservationHistoryEntry {
  date: string;
  signatures: string[];
  evidence: string[];
}

/** 多源事实行（HF 模型/Space、GitHub 搜索新仓库）。 */
export interface SourceFactRow {
  source: string;
  sourceId: string;
  title: string;
  url: string;
  itemType: string;
  metrics: Record<string, number>;
  capturedDate: string;
  firstSeenDate: string;
  historyDepth: number;
  /** 该源在窗口内出现过的不同日期数；<2 时禁用「新收录」。 */
  sourceDepth: number;
}

export interface DailyObservations {
  /** 北京日期（发送日）。 */
  date: string;
  dataDate: string | null;
  lines: ObservationLine[];
  /** null = 当天不发。 */
  message: string | null;
  /** 生成诊断（原始输出与丢弃原因），只进缓存供调参，不发给用户。 */
  debug?: unknown;
}

/** 校验阶段的丢弃原因计数；用于判断阈值/提示词是否过严。 */
export interface ValidationDiagnostics {
  total: number;
  invalidCandidate: number;
  emptyClaim: number;
  tooLong: number;
  missingRepo: number;
  badNumber: number;
  duplicate: number;
  kept: number;
  /** 多源观察超过 1 条被丢掉的次数。 */
  sourceShiftCapped?: number;
}

/** 观察消息的字节上限（企微 text 2048，留足余量）。 */
export const OBSERVATION_MAX_BYTES = 800;
/** 每条观察 claim 的汉字上限。 */
export const OBSERVATION_CLAIM_MAX_CHARS = 80;
/** 观察历史保留 8 天（覆盖 7 天窗口）。 */
export const OBSERVATION_HISTORY_DAYS = 7;
/** 最多 3 条，少于 2 条不发。 */
export const OBSERVATION_MAX_LINES = 3;
export const OBSERVATION_MIN_LINES = 2;

const ACCEL_RATIO = 1.8;
const ACCEL_MIN_DELTA = 200;
const STREAK_MIN_DAYS = 3;
const THEME_RATIO = 1.5;
const THEME_MIN_TODAY_LANGUAGE = 3;
const THEME_MIN_TODAY_TOPIC = 4;
const MAX_CANDIDATES = 10;
const MAX_REPO_CANDIDATES = 6;
const MAX_THEME_CANDIDATES = 4;

/**
 * 泛平台/泛形态话题：数量涨了往往只是「這周 Android 项目多」，
 * 不构成「社区在集中解决什么」的观察，反而会挤掉仓库级变化。
 */
const GENERIC_THEMES = new Set([
  'android',
  'ios',
  'macos',
  'windows',
  'linux',
  'web',
  'mobile',
  'api',
  'cli',
  'ui',
  'ux',
  'frontend',
  'backend',
  'database',
  'game',
  'games',
  'tool',
  'tools',
  'library',
  'framework',
]);

function normalizedName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function themeOfRow(row: ObservationFactRow, theme: string): boolean {
  return (
    (row.language ?? '').trim().toLowerCase() === theme ||
    row.topics.some((topic) => topic.trim().toLowerCase() === theme)
  );
}

/** 同主题里增量最高的其他仓库，用于给观察凑证据。 */
function peersFor(
  rows: ObservationFactRow[],
  row: ObservationFactRow,
  limit = 2,
): string[] {
  const themes = new Set<string>();
  if (row.language) themes.add(row.language.trim().toLowerCase());
  for (const topic of row.topics) themes.add(topic.trim().toLowerCase());

  return rows
    .filter((other) => other.fullName !== row.fullName)
    .filter((other) => {
      const otherThemes = new Set<string>();
      if (other.language) otherThemes.add(other.language.trim().toLowerCase());
      for (const topic of other.topics) otherThemes.add(topic.trim().toLowerCase());
      for (const theme of themes) {
        if (otherThemes.has(theme)) return true;
      }
      return false;
    })
    .sort((a, b) => b.deltaToday - a.deltaToday)
    .slice(0, limit)
    .map((other) => other.fullName);
}

function repoCandidate(
  kind: Exclude<ObservationKind, 'theme-shift'>,
  row: ObservationFactRow,
  facts: string,
  score: number,
  rows: ObservationFactRow[],
): ObservationCandidate {
  return {
    kind,
    signature: `repo:${normalizedName(row.fullName)}`,
    mainRepo: row.fullName,
    evidence: [row.fullName, ...peersFor(rows, row)].slice(0, 3),
    facts,
    score,
  };
}

/** 主题统计：今天数量、前 7 天均值、倍数。 */
export function buildThemeStats(rows: ThemeCountRow[], dataDate: string): ThemeStat[] {
  const groups = new Map<string, { kind: 'language' | 'topic'; today: number; prior: number[] }>();
  for (const row of rows) {
    const key = `${row.kind}:${row.theme}`;
    const entry = groups.get(key) ?? { kind: row.kind, today: 0, prior: [] };
    if (row.date === dataDate) {
      entry.today += row.count;
    } else {
      entry.prior.push(row.count);
    }
    groups.set(key, entry);
  }

  const stats: ThemeStat[] = [];
  for (const [key, entry] of groups) {
    const theme = key.slice(key.indexOf(':') + 1);
    const trailingAvg =
      entry.prior.length === 0
        ? 0
        : entry.prior.reduce((sum, value) => sum + value, 0) / entry.prior.length;
    stats.push({
      theme,
      kind: entry.kind,
      today: entry.today,
      trailingAvg,
      ratio: entry.today / (trailingAvg > 0 ? trailingAvg : 1),
    });
  }
  return stats;
}

/**
 * 候选判定（全部由代码完成）：
 * - 新上榜：首次出现就是数据日，且历史深度 ≥2；
 * - 加速：增量 ≥200 且 ≥昨天 1.8 倍，或排名跃升 ≥5 且增量 ≥200；
 * - 连续在榜：≥3 天且今天仍有增量；
 * - 主题变化：语言 ≥3 / 话题 ≥4，且 ≥1.5 倍基线、绝对增加 ≥2。
 * 结果按分数降序，最多 10 个。
 */
export function buildObservationCandidates(
  rows: ObservationFactRow[],
  themeRows: ThemeCountRow[],
  options: { dataDate: string; historyDepth: number },
): ObservationCandidate[] {
  const { dataDate, historyDepth } = options;
  if (historyDepth < 2) return [];

  const candidates: ObservationCandidate[] = [];

  for (const row of rows) {
    if (row.firstSeenDate === dataDate && row.daysOnList === 1) {
      candidates.push(
        repoCandidate(
          'new-entrant',
          row,
          `新上榜：首次出现 ${row.firstSeenDate}，今天 +${row.deltaToday}，stars ${row.stars}`,
          row.deltaToday,
          rows,
        ),
      );
    }

    const acceleratedAbsolute =
      row.daysOnList >= 2 &&
      row.deltaPrev !== null &&
      row.deltaPrev > 0 &&
      row.deltaToday >= ACCEL_MIN_DELTA &&
      row.deltaToday / row.deltaPrev >= ACCEL_RATIO;
    const acceleratedRank =
      row.daysOnList >= 2 &&
      row.deltaPrev === 0 &&
      row.deltaToday >= ACCEL_MIN_DELTA &&
      row.prevRank !== null &&
      row.rankToday !== null &&
      row.prevRank - row.rankToday >= 5;

    if (row.stars >= 200 && (acceleratedAbsolute || acceleratedRank)) {
      const ratio =
        row.deltaPrev !== null && row.deltaPrev > 0
          ? (row.deltaToday / row.deltaPrev).toFixed(1)
          : null;
      const facts =
        ratio !== null
          ? `加速：今天 +${row.deltaToday}，前一数据日 +${row.deltaPrev}（${ratio} 倍），stars ${row.stars}`
          : `加速：排名从 ${row.prevRank} 升到 ${row.rankToday}，今天 +${row.deltaToday}，stars ${row.stars}`;
      candidates.push(
        repoCandidate('acceleration', row, facts, row.deltaToday, rows),
      );
    }

    if (row.daysOnList >= STREAK_MIN_DAYS && row.deltaToday >= 50) {
      candidates.push(
        repoCandidate(
          'streak',
          row,
          `连续在榜 ${row.daysOnList} 天，今天 +${row.deltaToday}，stars ${row.stars}`,
          row.daysOnList * 100,
          rows,
        ),
      );
    }
  }

  for (const stat of buildThemeStats(themeRows, dataDate)) {
    if (stat.kind === 'topic' && GENERIC_THEMES.has(stat.theme)) continue;
    const threshold =
      stat.kind === 'topic' ? THEME_MIN_TODAY_TOPIC : THEME_MIN_TODAY_LANGUAGE;
    const enoughAbsolute = stat.today - stat.trailingAvg >= 2;
    if (stat.today < threshold || stat.ratio < THEME_RATIO || !enoughAbsolute) {
      continue;
    }
    const evidence = rows
      .filter((row) => themeOfRow(row, stat.theme))
      .sort((a, b) => b.deltaToday - a.deltaToday)
      .slice(0, 3)
      .map((row) => row.fullName);
    if (evidence.length < 2) continue;

    candidates.push({
      kind: 'theme-shift',
      signature: `theme:${stat.kind}:${stat.theme}`,
      mainRepo: null,
      evidence,
      facts: `主题 ${stat.theme}（${stat.kind}）：今天 ${stat.today} 个，近 7 天平均 ${stat.trailingAvg.toFixed(1)} 个（${evidence.slice(0, 2).join('、')} 等）`,
      score: stat.today * 100 + Math.round(stat.ratio * 10),
      theme: stat.theme,
    });
  }

  const seen = new Set<string>();
  const unique = candidates
    .sort((a, b) => b.score - a.score)
    .filter((candidate) => {
      if (seen.has(candidate.signature)) return false;
      seen.add(candidate.signature);
      return true;
    });

  // 仓库级变化与主题变化各留配额：主题的 today 计数天然比单仓库增量大，
  // 不配额的话 prompt 会被六个「某话题今天很多」淹没。
  const repos = unique
    .filter((candidate) => candidate.kind !== 'theme-shift')
    .slice(0, MAX_REPO_CANDIDATES);
  const themes = unique
    .filter((candidate) => candidate.kind === 'theme-shift')
    .slice(0, MAX_THEME_CANDIDATES);
  return [...repos, ...themes]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

/** 参与观察的「结构化」多源；HN/Lobsters 先只入库，不进观察。 */
export const OBSERVATION_SOURCES = ['hf_models', 'hf_spaces', 'github_search'] as const;
const MAX_SOURCE_CANDIDATES = 3;

/**
 * 多源候选：只取「今天首次收录、且该源已有历史深度」的条目。
 * GitHub 搜索与 Trending 的重叠按 fullName 去掉；HF 用 likes/downloads 打分。
 */
export function buildSourceCandidates(
  rows: SourceFactRow[],
  options: { dataDate: string; repoFullNames: Set<string> },
): ObservationCandidate[] {
  const out: ObservationCandidate[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.capturedDate !== options.dataDate) continue;
    if (row.sourceDepth < 2 || row.firstSeenDate !== options.dataDate) continue;

    const key = row.title.trim().toLowerCase();
    if (key === '' || options.repoFullNames.has(key) || seen.has(key)) continue;

    let facts: string;
    let score: number;
    if (row.source === 'github_search') {
      const stars = row.metrics.stars ?? 0;
      facts = `[GitHub 新仓库] ${row.title}：★${stars}（本周新建，首次收录）`;
      score = stars;
    } else {
      const likes = row.metrics.likes ?? 0;
      const downloads = row.metrics.downloads ?? 0;
      const label = row.source === 'hf_spaces' ? '[HF Space]' : '[HF 模型]';
      facts = `${label} ${row.title}：likes ${likes} · downloads ${downloads}（今日 trending，首次收录）`;
      score = likes * 100 + Math.round(downloads / 100);
    }
    if (score <= 0) continue;

    seen.add(key);
    out.push({
      kind: 'source-shift',
      signature: `src:${row.source}:${row.sourceId.toLowerCase()}`,
      mainRepo: null,
      evidence: [row.title],
      facts,
      score,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, MAX_SOURCE_CANDIDATES);
}

/** 多源事实：窗口内每个条目的最新捕获 + 首次收录日期 + 源历史深度。 */
export function composeSourceFactsSql(dataDate: string): SQL {
  return sql`
    with filtered as (
      select source, source_id, title, url, item_type, metrics, captured_date
      from source_items
      where source in ('hf_models', 'hf_spaces', 'github_search')
        and captured_date between (${dataDate}::date - 7) and ${dataDate}::date
    ),
    agg as (
      select
        source,
        source_id,
        min(captured_date) as first_seen_date,
        count(distinct captured_date)::int as history_depth
      from filtered
      group by source, source_id
    ),
    depth as (
      select source, count(distinct captured_date)::int as source_depth
      from filtered
      group by source
    )
    select
      f.source,
      f.source_id as "sourceId",
      f.title,
      f.url,
      f.item_type as "itemType",
      f.metrics,
      f.captured_date::text as "capturedDate",
      a.first_seen_date::text as "firstSeenDate",
      a.history_depth as "historyDepth",
      d.source_depth as "sourceDepth"
    from filtered f
    join agg a on a.source = f.source and a.source_id = f.source_id
    join depth d on d.source = f.source
    where f.captured_date = ${dataDate}::date
    order by f.source, f.source_id
  `;
}

/**
 * LLM 失败时的确定性兜底：直接拿候选事实当观察句子。
 * 句子不如模型润色，但保证网关挂掉时观察不消失；仍走去重与渲染。
 */
export function fallbackObservationLines(
  candidates: ObservationCandidate[],
): ObservationLine[] {
  const repos = candidates.filter((candidate) => candidate.kind !== 'source-shift');
  const source = candidates.find((candidate) => candidate.kind === 'source-shift');
  // 跨源条目通常排在主题/仓库候选后面；兜底时给它留一个位置，
  // 否则多源永远看不到（前三名会被主题观察占满）。
  const ordered = [
    ...repos.slice(0, 2),
    ...(source !== undefined ? [source] : []),
    ...repos.slice(2),
  ];

  const lines: ObservationLine[] = [];
  let sourceLines = 0;
  for (const candidate of ordered) {
    if (candidate.kind === 'source-shift') {
      if (sourceLines >= 1) continue;
      sourceLines += 1;
    }
    lines.push({
      kind: candidate.kind,
      signature: candidate.signature,
      claim: candidate.facts,
      evidence: candidate.evidence,
      ...(candidate.theme !== undefined ? { theme: candidate.theme } : {}),
    });
    if (lines.length >= OBSERVATION_MAX_LINES) break;
  }
  return lines;
}

/** 观察提示词：只给候选事实与证据仓库的功能短句，要求先判断、数字作证据。 */
export function buildObservationPrompt(
  candidates: ObservationCandidate[],
  summaries: Map<string, string> = new Map(),
): string {
  const evidence = (candidate: ObservationCandidate): string =>
    candidate.evidence
      .map((name) => {
        const summary = summaries.get(name)?.trim();
        return summary ? `${name}（${summary}）` : name;
      })
      .join('、');
  const lines = candidates.map((candidate, index) => {
    return `[${index + 1}] (${candidate.kind}) ${candidate.facts}｜证据：${evidence(candidate)}`;
  });
  return [
    '下面是今天 GitHub 热榜中「和过去 7 天不同」的事实候选。请写 2 到 3 条今日观察：',
    `1. 每条一句话、不超过 ${OBSERVATION_CLAIM_MAX_CHARS} 个汉字，先给判断、再说证据，回答「社区在集中解决什么问题」；`,
    '2. 不要用「今日 N 个」「平均 N 个」开头，也不要只复述数量；数字只作为句子里的证据；',
    '3. 只能引用候选里出现的仓库名和数字，不要编造任何列表之外的事实；',
    '4. 不要用「可能 / 也许 / 值得关注」这类空话，不要 emoji、不要链接；',
    '5. 每条对应一个候选编号；',
    '6. 多源条目（[GitHub 新仓库] / [HF …]）最多用一条，优先与仓库事实合并叙述；',
    '7. 以 JSON 输出：{"observations":[{"candidate":1,"claim":"一句话"}]}。',
    '',
    '示例风格（不是今天的事实）：设计工具集中上榜：ruff 与 hallmark 同时在解决「AI 生成的页面一眼假」的问题。',
    '',
    '候选：',
    ...lines,
  ].join('\n');
}

interface RawObservationOutput {
  observations?: unknown;
}

/** 从候选事实里抽出数字白名单（按数值比较，3.0 与 3 视为同一个）。 */
function numbersIn(text: string): Set<number> {
  const values = new Set<number>();
  for (const raw of text.match(/\d+(?:\.\d+)?/g) ?? []) {
    const value = Number(raw);
    if (Number.isFinite(value)) values.add(value);
  }
  return values;
}

function blankDiagnostics(): ValidationDiagnostics {
  return {
    total: 0,
    invalidCandidate: 0,
    emptyClaim: 0,
    tooLong: 0,
    missingRepo: 0,
    badNumber: 0,
    duplicate: 0,
    kept: 0,
  };
}

/**
 * 确定性校验（不信任模型）：
 * - 候选编号必须存在；
 * - claim 里的每个数字都必须在候选事实的白名单里；
 * - claim 必须提到至少一个证据仓库（全名或 `owner/repo` 的短名都算）；
 * - 最多 3 条，签名由候选决定。
 */
export function validateObservationOutput(
  out: RawObservationOutput | null | undefined,
  candidates: ObservationCandidate[],
  diagnostics: ValidationDiagnostics = blankDiagnostics(),
): ObservationLine[] {
  const raw = out?.observations;
  if (!Array.isArray(raw)) return [];
  diagnostics.total = raw.length;

  const lines: ObservationLine[] = [];
  const seen = new Set<string>();
  let sourceShiftLines = 0;

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      diagnostics.invalidCandidate += 1;
      continue;
    }
    const record = item as { candidate?: unknown; claim?: unknown };
    const index = typeof record.candidate === 'number' ? record.candidate - 1 : -1;
    const candidate = candidates[index];
    if (candidate === undefined) {
      diagnostics.invalidCandidate += 1;
      continue;
    }

    const claim = typeof record.claim === 'string' ? record.claim.trim() : '';
    if (claim === '') {
      diagnostics.emptyClaim += 1;
      continue;
    }
    if (Array.from(claim).length > OBSERVATION_CLAIM_MAX_CHARS) {
      diagnostics.tooLong += 1;
      continue;
    }

    // 模型经常把 `owner/repo` 写成 `repo`，甚至完全不点名（写成「一项目…」）。
    // 证据不靠模型：渲染层会把没提到的证据仓库补在行尾，这里只记诊断。
    const mentionsEvidence =
      (candidate.kind === 'theme-shift' &&
        candidate.theme !== undefined &&
        claim.toLowerCase().includes(candidate.theme.toLowerCase())) ||
      candidate.evidence.some((name) => {
        if (claim.includes(name)) return true;
        const shortName = name.split('/')[1];
        return shortName !== undefined && shortName !== '' && claim.includes(shortName);
      });
    if (!mentionsEvidence) diagnostics.missingRepo += 1;

    const allowed = numbersIn(candidate.facts);
    // 仓库名里天然带数字（llama.cpp、gpt-4、a/r0），不能把它们当成编造的数字。
    const claimWithoutRepoNames = claim.replace(
      /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g,
      ' ',
    );
    const numbers = (claimWithoutRepoNames.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (numbers.some((number) => !allowed.has(number))) {
      diagnostics.badNumber += 1;
      continue;
    }

    if (seen.has(candidate.signature)) {
      diagnostics.duplicate += 1;
      continue;
    }
    if (candidate.kind === 'source-shift') {
      if (sourceShiftLines >= 1) {
        diagnostics.sourceShiftCapped = (diagnostics.sourceShiftCapped ?? 0) + 1;
        continue;
      }
      sourceShiftLines += 1;
    }
    seen.add(candidate.signature);
    lines.push({
      kind: candidate.kind,
      signature: candidate.signature,
      claim,
      evidence: candidate.evidence,
      ...(candidate.theme !== undefined ? { theme: candidate.theme } : {}),
    });
    diagnostics.kept += 1;
    if (lines.length >= OBSERVATION_MAX_LINES) break;
  }

  return lines;
}

/**
 * 7 天去重：
 * - 相同签名出现过 → 丢；
 * - 证据仓库有 ≥2 个在过去 7 天的观察里出现过 → 丢（允许一个仓库以新语境回归）。
 */
export function passesNoveltyGate(
  line: ObservationLine,
  recent: ObservationHistoryEntry[],
): boolean {
  if (recent.some((entry) => entry.signatures.includes(line.signature))) {
    return false;
  }
  const seenEvidence = new Set(recent.flatMap((entry) => entry.evidence));
  const overlap = line.evidence.filter((name) => seenEvidence.has(name)).length;
  return overlap < 2;
}

/**
 * 渲染文本：`今日观察（MM-DD）` + 编号行。
 * 不再堆证据仓库列表：claim 没点名任何仓库时只补一个锚点。
 * 超预算从后往前删，少于 2 条返回 null。
 */
export function renderObservationMessage(
  lines: ObservationLine[],
  date: string,
): string | null {
  if (lines.length < OBSERVATION_MIN_LINES) return null;

  const header = `今日观察（${date.slice(5)}）`;
  const rendered: string[] = [];
  for (const [index, line] of lines.entries()) {
    const mentions = line.evidence.some((name) => {
      if (line.claim.includes(name)) return true;
      const shortName = name.split('/')[1];
      return shortName !== undefined && shortName !== '' && line.claim.includes(shortName);
    });
    const anchor = !mentions && line.evidence[0] ? `｜${line.evidence[0]}` : '';
    rendered.push(`${index + 1}. ${line.claim}${anchor}`);
  }

  while (rendered.length >= OBSERVATION_MIN_LINES) {
    const text = [header, ...rendered].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= OBSERVATION_MAX_BYTES) {
      return text;
    }
    rendered.pop();
  }
  return null;
}

/** 每条仓库事实 + 7 天窗口；面板/测试都直接编译这段 SQL。 */
export function composeObservationFactsSql(dataDate: string): SQL {
  return sql`
    with per_day as (
      select distinct on (te.full_name, te.date)
        te.full_name,
        te.date,
        te.stars_delta,
        te.rank,
        te.is_new
      from trending_entries te
      where te.period = 'daily'
        and te.date between (${dataDate}::date - 7) and ${dataDate}::date
      order by te.full_name, te.date, (te.language = 'all') desc, te.stars_delta desc
    ),
    agg as (
      select
        full_name,
        count(distinct date)::int as days_on_list,
        min(date) as first_seen_date,
        max(stars_delta) filter (where date = ${dataDate}::date - 1) as delta_prev,
        max(rank) filter (where date = ${dataDate}::date - 1) as prev_rank
      from per_day
      group by full_name
    )
    select
      p.full_name as "fullName",
      p.stars_delta as "deltaToday",
      p.rank as "rankToday",
      p.is_new as "isNew",
      a.days_on_list as "daysOnList",
      a.first_seen_date as "firstSeenDate",
      a.delta_prev as "deltaPrev",
      a.prev_rank as "prevRank",
      r.language,
      r.topics,
      r.stars,
      (select count(distinct date) from per_day) as "historyDepth"
    from per_day p
    join agg a using (full_name)
    join repos r on r.full_name = p.full_name
    where p.date = ${dataDate}::date
      and (p.stars_delta >= 50 or a.days_on_list >= 3 or p.is_new)
    order by p.stars_delta desc
    limit 80
  `;
}

/** 语言榜与话题榜的每日数量，用于主题变化判定。 */
export function composeThemeCountsSql(dataDate: string): SQL {
  return sql`
    with base as (
      select te.full_name, te.date
      from trending_entries te
      where te.period = 'daily'
        and te.language <> 'all'
        and te.date between (${dataDate}::date - 7) and ${dataDate}::date
    ),
    languages as (
      select lower(r.language) as theme, 'language' as kind, b.date, count(distinct b.full_name)::int as count
      from base b
      join repos r on r.full_name = b.full_name
      where r.language is not null and r.language <> ''
      group by 1, 2, 3
    ),
    topics as (
      select lower(topic) as theme, 'topic' as kind, b.date, count(distinct b.full_name)::int as count
      from base b
      join repos r on r.full_name = b.full_name
      cross join lateral jsonb_array_elements_text(r.topics) as topic
      group by 1, 2, 3
    )
    select * from languages
    union all
    select * from topics
  `;
}

// ---------------------------------------------------------------------------
// 集成层：缓存、7 天历史、LLM、每人每日标记
// ---------------------------------------------------------------------------

const OBSERVATION_CACHE_PREFIX = 'observation:v1:';
const OBSERVATION_SENT_PREFIX = 'observation-sent:v1:';
const ARCHIVE_PREFIX = 'archive:v1:';
const OBSERVATION_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const SENT_TTL_MS = 48 * 60 * 60 * 1000;
const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 观察的 LLM 超时：候选包含仓库 10 个 + 跨源最多 3 个，15 秒在实测中会
 * abort（llm:last-error 记录 timeout）；30 秒与 generateObjectSafe 默认一致。
 */
const LLM_TIMEOUT_MS = 30_000;

interface StoredObservations extends DailyObservations {
  generatedAt?: string;
}

const observationSchema = z.object({
  observations: z.array(z.object({ candidate: z.number(), claim: z.string() })),
});

/** `YYYY-MM-DD` 前推 n 天（按 UTC 日期算；纯日期没有夏令时问题）。 */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

async function readObservationCache(date: string): Promise<StoredObservations | null> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(sql`${kvCache.key} = ${`${OBSERVATION_CACHE_PREFIX}${date}`}`);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const value = row.value as Partial<StoredObservations> | null;
  if (!value || typeof value.date !== 'string' || !Array.isArray(value.lines)) {
    return null;
  }
  return value as StoredObservations;
}

async function writeObservationCache(result: DailyObservations): Promise<void> {
  const expiresAt = new Date(Date.now() + OBSERVATION_TTL_MS);
  await db()
    .insert(kvCache)
    .values({
      key: `${OBSERVATION_CACHE_PREFIX}${result.date}`,
      value: { ...result, generatedAt: new Date().toISOString() },
      expiresAt,
    })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: {
        value: sql`excluded.value`,
        expiresAt: sql`excluded.expires_at`,
      },
    });
}

/** 过去 7 天的观察签名与证据；任何读取错误向上抛，由调用方 fail closed。 */
async function readObservationHistory(
  date: string,
): Promise<ObservationHistoryEntry[]> {
  const keys = Array.from({ length: OBSERVATION_HISTORY_DAYS }, (_, index) =>
    `${OBSERVATION_CACHE_PREFIX}${shiftDate(date, -(index + 1))}`,
  );
  const rows = await db()
    .select()
    .from(kvCache)
    .where(inArray(kvCache.key, keys));

  const entries: ObservationHistoryEntry[] = [];
  for (const row of rows) {
    if (new Date(row.expiresAt).getTime() <= Date.now()) continue;
    const value = row.value as Partial<StoredObservations> | null;
    if (!value || !Array.isArray(value.lines)) continue;
    const lines = value.lines as ObservationLine[];
    entries.push({
      date: String(value.date ?? ''),
      signatures: lines.map((line) => String(line.signature)),
      evidence: lines.flatMap((line) => line.evidence.map(String)),
    });
  }
  return entries;
}

async function queryFacts(dataDate: string): Promise<ObservationFactRow[]> {
  const { rows } = await db().execute(composeObservationFactsSql(dataDate));
  return rows.map((row) => ({
    fullName: String(row.fullName),
    language: row.language == null ? null : String(row.language),
    topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
    stars: Number(row.stars),
    deltaToday: Number(row.deltaToday),
    deltaPrev: row.deltaPrev == null ? null : Number(row.deltaPrev),
    prevRank: row.prevRank == null ? null : Number(row.prevRank),
    rankToday: row.rankToday == null ? null : Number(row.rankToday),
    daysOnList: Number(row.daysOnList),
    firstSeenDate: String(row.firstSeenDate).slice(0, 10),
    isNew: Boolean(row.isNew),
    historyDepth: Number(row.historyDepth ?? 0),
  }));
}

async function queryThemes(dataDate: string): Promise<ThemeCountRow[]> {
  const { rows } = await db().execute(composeThemeCountsSql(dataDate));
  return rows.map((row) => ({
    theme: String(row.theme),
    kind: row.kind === 'topic' ? 'topic' : 'language',
    date: String(row.date).slice(0, 10),
    count: Number(row.count),
  }));
}

async function querySourceFacts(dataDate: string): Promise<SourceFactRow[]> {
  const { rows } = await db().execute(composeSourceFactsSql(dataDate));
  return rows.map((row) => ({
    source: String(row.source),
    sourceId: String(row.sourceId),
    title: String(row.title),
    url: String(row.url),
    itemType: String(row.itemType),
    metrics:
      row.metrics && typeof row.metrics === 'object'
        ? (row.metrics as Record<string, number>)
        : {},
    capturedDate: String(row.capturedDate).slice(0, 10),
    firstSeenDate: String(row.firstSeenDate).slice(0, 10),
    historyDepth: Number(row.historyDepth ?? 0),
    sourceDepth: Number(row.sourceDepth ?? 0),
  }));
}

/**
 * 生成当天观察（全局共享一次）。
 * - 无快照/无 dataDate/无候选 → 空结果（缓存，避免每小时重跑）；
 * - 历史读取失败 → fail closed，返回 null（不生成、不缓存）；
 * - 模型失败 → 空结果缓存；
 * - 没有任何通过去重的观察 → message=null（当天不发）。
 */
export async function getDailyObservations(
  snapshot: DigestSnapshot | null,
  now: Date = new Date(),
): Promise<DailyObservations | null> {
  if (snapshot === null || snapshot.items.length === 0) return null;
  const dataDate = snapshot.dataDate;
  if (dataDate === null) return null;

  const date = shanghaiToday(now);

  let cached: StoredObservations | null = null;
  try {
    cached = await readObservationCache(date);
  } catch {
    cached = null;
  }
  if (cached !== null && cached.dataDate === dataDate) {
    return cached;
  }

  let history: ObservationHistoryEntry[];
  try {
    history = await readObservationHistory(date);
  } catch {
    // 去重是这个功能存在的理由；读不到历史就不发，绝不冒险重复。
    return null;
  }

  let facts: ObservationFactRow[];
  let themes: ThemeCountRow[];
  try {
    facts = await queryFacts(dataDate);
    themes = await queryThemes(dataDate);
  } catch {
    return null;
  }

  const historyDepth = facts.length > 0 ? Number(facts[0].historyDepth ?? 0) : 0;
  const repoCandidates = buildObservationCandidates(facts, themes, {
    dataDate,
    historyDepth,
  });

  let sourceRows: SourceFactRow[] = [];
  try {
    sourceRows = await querySourceFacts(dataDate);
  } catch {
    // 多源缺失/表未建：仓库观察照常，不因跨源失败丢掉整个观察。
    sourceRows = [];
  }
  const repoFullNames = new Set(facts.map((row) => row.fullName.toLowerCase()));
  const sourceCandidates = buildSourceCandidates(sourceRows, {
    dataDate,
    repoFullNames,
  });
  const candidates = [...repoCandidates, ...sourceCandidates];

  let lines: ObservationLine[] = [];
  let debug: unknown = { candidates: candidates.length };
  if (candidates.length > 0) {
    const summaries = new Map(
      snapshot.items.map((item) => [item.fullName, item.short ?? item.summary ?? '']),
    );
    const out = await generateObjectSafe(
      observationSchema,
      buildObservationPrompt(candidates, summaries),
      undefined,
      { timeoutMs: LLM_TIMEOUT_MS },
    ).catch(() => null);
    const validation = blankDiagnostics();
    const validated = validateObservationOutput(out, candidates, validation);
    // 网关超时/失败时用确定性事实兜底；模型正常但输出被校验丢弃时不兜底
    // （那说明模型在编造，宁可当天不发）。
    const base = out === null ? fallbackObservationLines(candidates) : validated;
    lines = base.filter((line) => passesNoveltyGate(line, history));
    debug = {
      llm: out === null ? 'fallback' : 'ok',
      validation,
      noveltyDropped: base.length - lines.length,
      raw: out?.observations?.slice(0, 5).map((item) => item.claim) ?? [],
    };
  }

  const result: DailyObservations = {
    date,
    dataDate,
    lines,
    message: renderObservationMessage(lines, date),
    debug,
  };
  try {
    await writeObservationCache(result);
  } catch {
    // 缓存失败不影响本次结果；下个整点会重新生成。
  }
  try {
    await writeArchive(snapshot, result);
  } catch {
    // 归档只服务面板，失败绝不外抛。
  }
  return result;
}

/**
 * 历史归档：面板（Phase 2.5）要能回看过去 30 天的观察与当天条目，
 * 而 `digest-snapshot:<date>` 只有 24h TTL。这里写一份轻量副本。
 */
async function writeArchive(
  snapshot: DigestSnapshot,
  result: DailyObservations,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ARCHIVE_TTL_MS);
  const items = snapshot.items.slice(0, 8).map((item) => ({
    fullName: item.fullName,
    stars: item.stars,
    starsDelta: item.starsDelta,
    language: item.language,
    summary: item.short ?? item.summary ?? null,
    url: item.htmlUrl,
  }));
  await db()
    .insert(kvCache)
    .values({
      key: `${ARCHIVE_PREFIX}${result.date}`,
      value: { date: result.date, dataDate: result.dataDate, message: result.message, items },
      expiresAt,
    })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
    });
}

function sentKey(date: string, userid: string): string {
  return `${OBSERVATION_SENT_PREFIX}${date}:${userid}`;
}

/** 该用户今天是否已经收到过观察（marker 在发送前写入，at-most-once）。 */
export async function wasObservationSent(
  userid: string,
  date: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db()
    .select()
    .from(kvCache)
    .where(sql`${kvCache.key} = ${sentKey(date, userid)}`);
  const row = rows[0];
  if (!row) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

/** 写入 48h 标记；调用方应在发送前写，宁可少发一次也不重复。 */
export async function markObservationSent(
  userid: string,
  date: string,
  now: Date = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + SENT_TTL_MS);
  await db()
    .insert(kvCache)
    .values({ key: sentKey(date, userid), value: { sent: true }, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
    });
}
