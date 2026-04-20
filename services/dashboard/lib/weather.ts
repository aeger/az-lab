import { getConfig } from './config'
export type { WeatherData, WeatherCurrent, WeatherDaily } from './weather-utils'
export { weatherCodeToIcon, weatherCodeToLabel } from './weather-utils'
import type { WeatherData, WeatherDaily } from './weather-utils'

export async function fetchWeather(): Promise<WeatherData> {
  const config = getConfig()
  const { latitude, longitude, location } = config.weather

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'America/Phoenix',
    forecast_days: '6',
  })

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    next: { revalidate: 1800 },
  })

  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`)

  const data = await res.json()

  const daily: WeatherDaily[] = data.daily.time.slice(1, 6).map((date: string, i: number) => ({
    date,
    temp_max: Math.round(data.daily.temperature_2m_max[i + 1]),
    temp_min: Math.round(data.daily.temperature_2m_min[i + 1]),
    weather_code: data.daily.weather_code[i + 1],
  }))

  return {
    current: {
      temperature: Math.round(data.current.temperature_2m),
      apparent_temperature: Math.round(data.current.apparent_temperature),
      weather_code: data.current.weather_code,
      wind_speed: Math.round(data.current.wind_speed_10m),
      humidity: data.current.relative_humidity_2m,
    },
    daily,
    location,
  }
}
