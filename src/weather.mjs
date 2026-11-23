const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Moderate showers',
  82: 'Heavy showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Severe thunderstorm',
};

export function describeWeatherCode(code) {
  return WMO_CODES[Number(code)] || 'Variable conditions';
}

export async function fetchWeather(weatherConfig, options = {}) {
  if (!weatherConfig || weatherConfig.enabled === false) return null;
  const fetchImpl = options.fetch || globalThis.fetch;
  const unit = weatherConfig.unit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  const params = new URLSearchParams({
    latitude: String(weatherConfig.latitude),
    longitude: String(weatherConfig.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    temperature_unit: unit,
    timezone: options.timezone || 'auto',
    forecast_days: '1',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Weather API responded with HTTP ${res.status}`);
  }
  const data = await res.json();
  const current = data.current || {};
  const daily = data.daily || {};
  const unitSymbol = unit === 'fahrenheit' ? '°F' : '°C';

  return {
    city: weatherConfig.city || 'Local',
    unit: unitSymbol,
    currentTemp: Math.round(current.temperature_2m ?? 0),
    feelsLike: Math.round(current.apparent_temperature ?? current.temperature_2m ?? 0),
    high: Math.round((daily.temperature_2m_max || [0])[0]),
    low: Math.round((daily.temperature_2m_min || [0])[0]),
    rainChance: Math.round((daily.precipitation_probability_max || [0])[0]),
    condition: describeWeatherCode(daily.weather_code?.[0] ?? current.weather_code),
    fetchedAt: new Date().toISOString(),
  };
}
