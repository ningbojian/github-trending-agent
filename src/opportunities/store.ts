import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

const HIDDEN_PREFIX = 'opportunity-hidden:';
const SHOWN_PREFIX = 'opportunity-shown:';
const HIDDEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SHOWN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_IDS = 200;

interface ShownEntry {
  id: string;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseShown(value: unknown): { entries: ShownEntry[]; legacy: string[] } {
  if (!isRecord(value)) return { entries: [], legacy: [] };
  const entries = Array.isArray(value.entries)
    ? value.entries.flatMap((entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.at === 'string'
          ? [{ id: entry.id, at: entry.at }]
          : [],
      )
    : [];
  const legacy = Array.isArray(value.ids)
    ? value.ids.filter((id): id is string => typeof id === 'string')
    : [];
  return { entries, legacy };
}

async function readShownValue(
  key: string,
): Promise<{ entries: ShownEntry[]; legacy: string[] } | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, key));
    const row = rows[0];
    if (!row) return null;
    const expiresAt =
      row.expiresAt instanceof Date
        ? row.expiresAt
        : new Date(String(row.expiresAt ?? ''));
    if (
      Number.isFinite(expiresAt.getTime()) &&
      expiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    return parseShown(row.value);
  } catch {
    return null;
  }
}

async function writeShown(
  key: string,
  entries: ShownEntry[],
  ttlMs: number,
): Promise<void> {
  const value = {
    entries: entries.slice(0, MAX_IDS),
    updatedAt: new Date().toISOString(),
  };
  const expiresAt = new Date(Date.now() + ttlMs);
  await db()
    .insert(kvCache)
    .values({ key, value, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value, expiresAt },
    });
}

async function readIds(key: string): Promise<string[]> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, key));
    const row = rows[0];
    if (!row) return [];
    const expiresAt =
      row.expiresAt instanceof Date
        ? row.expiresAt
        : new Date(String(row.expiresAt ?? ''));
    if (
      Number.isFinite(expiresAt.getTime()) &&
      expiresAt.getTime() <= Date.now()
    ) {
      return [];
    }
    const value = row.value;
    if (!isRecord(value) || !Array.isArray(value.ids)) return [];
    return value.ids.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

async function writeIds(
  key: string,
  ids: string[],
  ttlMs: number,
): Promise<void> {
  const value = {
    ids: [...new Set(ids)].slice(-MAX_IDS),
    updatedAt: new Date().toISOString(),
  };
  const expiresAt = new Date(Date.now() + ttlMs);
  await db()
    .insert(kvCache)
    .values({ key, value, expiresAt })
    .onConflictDoUpdate({
      target: kvCache.key,
      set: { value, expiresAt },
    });
}

export async function readHiddenOpportunities(
  userid: string,
): Promise<Set<string>> {
  return new Set(await readIds(`${HIDDEN_PREFIX}${userid}`));
}

export async function hideOpportunity(
  userid: string,
  id: string,
): Promise<void> {
  const key = `${HIDDEN_PREFIX}${userid}`;
  const current = await readIds(key);
  await writeIds(key, [...current, id], HIDDEN_TTL_MS);
}

export async function readShownOpportunities(
  userid: string,
  windowMs: number = SHOWN_TTL_MS,
): Promise<Set<string>> {
  const current = await readShownValue(`${SHOWN_PREFIX}${userid}`);
  if (current === null) return new Set();
  const cutoff = Date.now() - windowMs;
  const ids = new Set<string>();
  for (const entry of current.entries) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at >= cutoff) ids.add(entry.id);
  }
  // 旧格式 { ids }：没有时间戳，按仍在展示处理，随行 TTL 过期。
  for (const id of current.legacy) ids.add(id);
  return ids;
}

export async function markOpportunitiesShown(
  userid: string,
  ids: string[],
  windowMs: number = SHOWN_TTL_MS,
): Promise<void> {
  const key = `${SHOWN_PREFIX}${userid}`;
  const current = await readShownValue(key);
  const now = new Date();
  const cutoff = now.getTime() - windowMs;
  const byId = new Map<string, string>();
  for (const entry of current?.entries ?? []) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at >= cutoff) byId.set(entry.id, entry.at);
  }
  for (const id of current?.legacy ?? []) {
    if (!byId.has(id)) byId.set(id, now.toISOString());
  }
  for (const id of ids) byId.set(id, now.toISOString());
  const entries = [...byId.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, MAX_IDS)
    .map(([id, at]) => ({ id, at }));
  // 行 TTL 保持 14 天：7 天窗口 + 7 天发送间隔时，不会正好在边界丢 key。
  await writeShown(key, entries, Math.max(SHOWN_TTL_MS, windowMs));
}
