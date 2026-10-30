import { describe, expect, it } from 'vitest';
import { AUTO_CITY, cityBySlug, DEFAULT_CITY } from '../src/weather/cities';
import { dayStickerFor, weatherIconFor, weekdayIndex } from '../src/weather/outfit';
import { conditionFromCode, resolveCity } from '../src/weather/service';

describe('weather cities', () => {
  it('resolves known slugs and ignores auto/unknown', () => {
    expect(cityBySlug('hangzhou')?.name).toBe('杭州');
    expect(cityBySlug(AUTO_CITY)).toBeNull();
    expect(cityBySlug('atlantis')).toBeNull();
    expect(cityBySlug(undefined)).toBeNull();
  });

  it('prefers a manual city over IP headers', () => {
    const city = resolveCity(
      {
        'x-vercel-ip-latitude': '39.9',
        'x-vercel-ip-longitude': '116.4',
        'x-vercel-ip-city': '%E5%8C%97%E4%BA%AC',
      },
      'hangzhou',
    );
    expect(city.name).toBe('杭州');
    expect(city.source).toBe('manual');
  });

  it('uses IP coordinates and decodes the city name', () => {
    const city = resolveCity(
      {
        'x-vercel-ip-latitude': '30.27',
        'x-vercel-ip-longitude': '120.15',
        'x-vercel-ip-city': '%E6%9D%AD%E5%B7%9E',
      },
      AUTO_CITY,
    );
    expect(city).toMatchObject({ name: '杭州', latitude: 30.27, longitude: 120.15, source: 'ip' });
  });

  it('falls back to Beijing without usable headers', () => {
    const city = resolveCity({}, AUTO_CITY);
    expect(city).toMatchObject({ name: DEFAULT_CITY.name, source: 'default' });
  });
});

describe('weather code mapping', () => {
  it('maps WMO codes to the four sticker states', () => {
    expect(conditionFromCode(0)).toBe('clear');
    expect(conditionFromCode(2)).toBe('cloud');
    expect(conditionFromCode(45)).toBe('fog');
    expect(conditionFromCode(61)).toBe('rain');
    expect(conditionFromCode(80)).toBe('rain');
    expect(conditionFromCode(75)).toBe('snow');
    expect(conditionFromCode(86)).toBe('snow');
    expect(conditionFromCode(95)).toBe('thunder');
    expect(conditionFromCode(999)).toBe('cloud');
  });
});

describe('outfit selection', () => {
  it('uses Beijing weekday: Monday cap, Thursday bulb, Sunday coffee', () => {
    expect(weekdayIndex(new Date('2026-10-26T00:00:00Z'))).toBe(0);
    expect(dayStickerFor(new Date('2026-10-26T00:00:00Z')).sticker).toBe('cap');
    expect(dayStickerFor(new Date('2026-10-29T00:00:00Z')).sticker).toBe('bulb');
    expect(dayStickerFor(new Date('2026-11-01T00:00:00Z')).sticker).toBe('coffee');
  });

  it('maps weather to a weather icon, including fallbacks', () => {
    expect(weatherIconFor(null)).toBe('cloud');
    expect(weatherIconFor({ condition: 'rain', temperature: 18, city: 'x' })).toBe('rain');
    expect(weatherIconFor({ condition: 'thunder', temperature: 18, city: 'x' })).toBe('rain');
    expect(weatherIconFor({ condition: 'snow', temperature: -2, city: 'x' })).toBe('snow');
    expect(weatherIconFor({ condition: 'clear', temperature: 33, city: 'x' })).toBe('fire');
    expect(weatherIconFor({ condition: 'clear', temperature: 4, city: 'x' })).toBe('snow');
    expect(weatherIconFor({ condition: 'clear', temperature: 22, city: 'x' })).toBe('sun');
  });
});
