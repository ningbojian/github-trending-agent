import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';

const HIDDEN_PREFIX = 'opportunity-hidden:';
const SHOWN_PREFIX = 'opportunity-shown:';
const HIDDEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SHOWN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_IDS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
): Promise<Set<string>> {
  return new Set(await readIds(`${SHOWN_PREFIX}${userid}`));
}

export async function markOpportunitiesShown(
  userid: string,
  ids: string[],
): Promise<void> {
  const key = `${SHOWN_PREFIX}${userid}`;
  const current = await readIds(key);
  await writeIds(key, [...current, ...ids], SHOWN_TTL_MS);
}
