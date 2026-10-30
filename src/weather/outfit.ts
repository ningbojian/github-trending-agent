import { shanghaiToday } from '../agent/time.js';
import type { Weather } from './service.js';

/**
 * 面板机器人的日贴纸 + 天气图标。
 *
 * 纯函数：不碰 DB/网络。周一从 0 开始；天气只取四种表情。
 */

export type DaySticker = 'cap' | 'headphones' | 'scarf' | 'bulb' | 'coat' | 'sunglasses' | 'coffee';
export type WeatherIcon = 'sun' | 'rain' | 'snow' | 'fire' | 'cloud';

const WEEKDAY_STICKERS: Array<{ sticker: DaySticker; name: string }> = [
  { sticker: 'cap', name: '棒球帽' },
  { sticker: 'headphones', name: '耳机' },
  { sticker: 'scarf', name: '围巾' },
  { sticker: 'bulb', name: '灯泡' },
  { sticker: 'coat', name: '外套' },
  { sticker: 'sunglasses', name: '墨镜' },
  { sticker: 'coffee', name: '咖啡' },
];

/** 北京时间的星期几：0 = 周一，6 = 周日。 */
export function weekdayIndex(now: Date): number {
  const today = shanghaiToday(now);
  const date = new Date(`${today}T00:00:00Z`);
  return (date.getUTCDay() + 6) % 7;
}

export function dayStickerFor(now: Date): { sticker: DaySticker; name: string } {
  return WEEKDAY_STICKERS[weekdayIndex(now)]!;
}

/** 天气球：雨/雪优先，其次看温度，最后才是晴。 */
export function weatherIconFor(weather: Weather | null): WeatherIcon {
  if (weather === null) return 'cloud';
  if (weather.condition === 'rain' || weather.condition === 'thunder') return 'rain';
  if (weather.condition === 'snow') return 'snow';
  if (weather.temperature >= 28) return 'fire';
  if (weather.temperature <= 5) return 'snow';
  return 'sun';
}

/** Twemoji codepoint（静态文件在 /docs/assets/emoji/<code>.svg）。 */
export const STICKER_CODES: Record<DaySticker, string> = {
  cap: '1f9e2',
  headphones: '1f3a7',
  scarf: '1f9e3',
  bulb: '1f4a1',
  coat: '1f9e5',
  sunglasses: '1f576',
  coffee: '2615',
};

export const WEATHER_CODES: Record<WeatherIcon, string> = {
  sun: '2600',
  rain: '1f327',
  snow: '2744',
  fire: '1f525',
  cloud: '2601',
};
