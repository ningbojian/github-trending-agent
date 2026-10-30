import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kvCache } from '../db/schema.js';
import {
  cityBySlug,
  DEFAULT_CITY,
  type WeatherCity,
} from './cities.js';

/**
 * 天气：只给面板的机器人换一颗天气小球。
 *
 * - 默认按 Vercel 的请求 IP 粗定位（城市级），没有就回退北京；
 * - 用户在设置里选了城市就优先用城市；
 * - Open-Meteo 免费接口，1.5 秒超时；失败返回 null，机器人只显示日贴纸；
 * - 按 0.1° 网格缓存 3 小时，避免每次打开面板都打一次外部接口。
 */

export type WeatherCondition = 'clear' | 'cloud' | 'rain' | 'snow' | 'thunder' | 'fog';

export interface Weather {
  condition: WeatherCondition;
  temperature: number;
  city: string;
}

export type WeatherSource = 'manual' | 'ip' | 'default';

export interface ResolvedCity extends WeatherCity {
  source: WeatherSource;
}

type HeadersLike = Record<string, string | string[] | undefined> | undefined;

function headerValue(headers: HeadersLike, name: string): string {
  const value = headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function decodeCity(value: string): string {
  if (value === '') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 手动城市 > Vercel IP 粗定位 > 北京。 */
export function resolveCity(headers: HeadersLike, selectedSlug: unknown): ResolvedCity {
  const manual = cityBySlug(selectedSlug);
  if (manual) {
    return { ...manual, source: 'manual' };
  }
  const rawLatitude = headerValue(headers, 'x-vercel-ip-latitude').trim();
  const rawLongitude = headerValue(headers, 'x-vercel-ip-longitude').trim();
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (
    rawLatitude !== '' &&
    rawLongitude !== '' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return {
      slug: 'ip',
      name: decodeCity(headerValue(headers, 'x-vercel-ip-city')) || '你所在的位置',
      latitude,
      longitude,
      source: 'ip',
    };
  }
  return { ...DEFAULT_CITY, source: 'default' };
}

/** WMO weather code → 四种够用的状态。 */
export function conditionFromCode(code: number): WeatherCondition {
  if (code === 0) return 'clear';
  if (code <= 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunder';
  return 'cloud';
}

interface CachedWeather {
  condition: WeatherCondition;
  temperature: number;
}

const CACHE_PREFIX = 'weather:v1:';
const MISS_PREFIX = 'weather-miss:v1:';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

function cacheKey(city: WeatherCity): string {
  return `${CACHE_PREFIX}${city.latitude.toFixed(1)}:${city.longitude.toFixed(1)}`;
}

function isCachedWeather(value: unknown): value is CachedWeather {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.condition === 'string' &&
    typeof record.temperature === 'number' &&
    Number.isFinite(record.temperature)
  );
}

async function readCache(key: string, now: Date): Promise<CachedWeather | null> {
  try {
    const rows = await db()
      .select({ value: kvCache.value, expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, key))
      .limit(1);
    const row = rows[0];
    if (!row || new Date(row.expiresAt).getTime() <= now.getTime()) return null;
    return isCachedWeather(row.value) ? row.value : null;
  } catch (err) {
    console.warn('[weather] cache read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function writeCache(key: string, weather: CachedWeather, now: Date): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key,
        value: weather,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    console.warn('[weather] cache write failed:', err instanceof Error ? err.message : err);
  }
}

/** 失败负缓存：接口抖的时候，10 分钟内不再重试，避免每次开面板都等超时。 */
async function readMiss(key: string, now: Date): Promise<boolean> {
  try {
    const rows = await db()
      .select({ expiresAt: kvCache.expiresAt })
      .from(kvCache)
      .where(eq(kvCache.key, `${MISS_PREFIX}${key}`))
      .limit(1);
    const row = rows[0];
    return row !== undefined && new Date(row.expiresAt).getTime() > now.getTime();
  } catch {
    return false;
  }
}

async function writeMiss(key: string, now: Date): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: `${MISS_PREFIX}${key}`,
        value: { miss: true },
        expiresAt: new Date(now.getTime() + MISS_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: { miss: true }, expiresAt: new Date(now.getTime() + MISS_TTL_MS) },
      });
  } catch {
    // 负缓存失败不影响主流程。
  }
}

/** 直接请求 Open-Meteo；失败/超时返回 null。 */
export async function fetchWeather(
  latitude: number,
  longitude: number,
): Promise<CachedWeather | null> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${encodeURIComponent(String(latitude))}` +
    `&longitude=${encodeURIComponent(String(longitude))}` +
    '&current=temperature_2m,weather_code&timezone=auto';
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'ghtrending-agent' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      current?: { temperature_2m?: unknown; weather_code?: unknown };
    };
    const temperature = Number(data.current?.temperature_2m);
    const code = Number(data.current?.weather_code);
    if (!Number.isFinite(temperature) || !Number.isFinite(code)) return null;
    return {
      condition: conditionFromCode(code),
      temperature: Math.round(temperature * 10) / 10,
    };
  } catch (err) {
    console.warn('[weather] fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 面板入口：解析城市 → 读缓存 → 请求 → 写缓存。任何失败都只返回 null。 */
export async function getWeatherForRequest(
  headers: HeadersLike,
  selectedSlug: unknown,
  now: Date = new Date(),
): Promise<Weather | null> {
  const city = resolveCity(headers, selectedSlug);
  const key = cacheKey(city);
  const cached = await readCache(key, now);
  if (cached !== null) {
    return { ...cached, city: city.name };
  }
  if (await readMiss(key, now)) return null;
  const fresh = await fetchWeather(city.latitude, city.longitude);
  if (fresh === null) {
    await writeMiss(key, now);
    return null;
  }
  await writeCache(key, fresh, now);
  return { ...fresh, city: city.name };
}
