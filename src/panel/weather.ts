import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscribers } from '../db/schema.js';
import { AUTO_CITY } from '../weather/cities.js';
import { getWeatherForRequest, type Weather } from '../weather/service.js';

/**
 * 面板每个视图共用的天气。
 *
 * 一次请求只解析一次用户城市（订阅偏好里的 weatherCity，缺省按 IP 自动），
 * 然后交给天气服务——它自己按城市缓存 3 小时，所以「总览打一次接口、子页用缓存」
 * 是服务层保证的，不需要在页面层各自决定要不要天气。
 *
 * 失败（DB / Open-Meteo）返回 null：机器人天气球退化为云，不影响页面其余部分。
 */
export async function weatherForPanel(
  userid: string,
  headers: Record<string, string | string[] | undefined> | undefined,
  now: Date = new Date(),
): Promise<Weather | null> {
  try {
    const rows = await db()
      .select({ preferences: subscribers.preferences })
      .from(subscribers)
      .where(eq(subscribers.wecomUserid, userid))
      .limit(1);
    const raw = (rows[0]?.preferences as { weatherCity?: unknown } | undefined)
      ?.weatherCity;
    const citySlug = typeof raw === 'string' ? raw : AUTO_CITY;
    return await getWeatherForRequest(headers, citySlug, now);
  } catch (err) {
    console.error(
      'panel weather failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
