/** 天气城市：只存粗粒度的城市中心坐标，用于 Open-Meteo。 */
export interface WeatherCity {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

export const AUTO_CITY = 'auto';

/** 覆盖面优先：常见城市即可，不追求全国区县。 */
export const WEATHER_CITIES: WeatherCity[] = [
  { slug: 'beijing', name: '北京', latitude: 39.9042, longitude: 116.4074 },
  { slug: 'shanghai', name: '上海', latitude: 31.2304, longitude: 121.4737 },
  { slug: 'guangzhou', name: '广州', latitude: 23.1291, longitude: 113.2644 },
  { slug: 'shenzhen', name: '深圳', latitude: 22.5431, longitude: 114.0579 },
  { slug: 'hangzhou', name: '杭州', latitude: 30.2741, longitude: 120.1551 },
  { slug: 'chengdu', name: '成都', latitude: 30.5728, longitude: 104.0668 },
  { slug: 'wuhan', name: '武汉', latitude: 30.5928, longitude: 114.3055 },
  { slug: 'nanjing', name: '南京', latitude: 32.0603, longitude: 118.7969 },
  { slug: 'xian', name: '西安', latitude: 34.3416, longitude: 108.9398 },
  { slug: 'chongqing', name: '重庆', latitude: 29.563, longitude: 106.5516 },
  { slug: 'suzhou', name: '苏州', latitude: 31.2989, longitude: 120.5853 },
  { slug: 'tianjin', name: '天津', latitude: 39.3434, longitude: 117.3616 },
  { slug: 'changsha', name: '长沙', latitude: 28.2282, longitude: 112.9388 },
  { slug: 'zhengzhou', name: '郑州', latitude: 34.7466, longitude: 113.6254 },
  { slug: 'qingdao', name: '青岛', latitude: 36.0671, longitude: 120.3826 },
  { slug: 'xiamen', name: '厦门', latitude: 24.4798, longitude: 118.0894 },
  { slug: 'fuzhou', name: '福州', latitude: 26.0745, longitude: 119.2965 },
  { slug: 'hefei', name: '合肥', latitude: 31.8206, longitude: 117.2272 },
  { slug: 'kunming', name: '昆明', latitude: 25.0389, longitude: 102.7183 },
  { slug: 'dalian', name: '大连', latitude: 38.914, longitude: 121.6147 },
  { slug: 'hongkong', name: '香港', latitude: 22.3193, longitude: 114.1694 },
  { slug: 'taipei', name: '台北', latitude: 25.033, longitude: 121.5654 },
];

export const DEFAULT_CITY: WeatherCity = WEATHER_CITIES[0]!;

/** 设置里保存的 slug → 城市；非法/缺失返回 null（调用方回退 auto）。 */
export function cityBySlug(slug: unknown): WeatherCity | null {
  if (typeof slug !== 'string') return null;
  return WEATHER_CITIES.find((city) => city.slug === slug) ?? null;
}
