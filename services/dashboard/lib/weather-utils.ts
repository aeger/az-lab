// Client-safe weather utilities (no server imports)

export function weatherCodeToIcon(code: number): string {
  if (code === 0) return '☀️'
  if (code <= 2) return '⛅'
  if (code === 3) return '☁️'
  if (code <= 49) return '🌫️'
  if (code <= 59) return '🌦️'
  if (code <= 69) return '🌧️'
  if (code <= 79) return '❄️'
  if (code <= 84) return '🌧️'
  if (code <= 94) return '⛈️'
  return '🌩️'
}

export function weatherCodeToLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code <= 2) return 'Partly Cloudy'
  if (code === 3) return 'Cloudy'
  if (code <= 49) return 'Foggy'
  if (code <= 59) return 'Drizzle'
  if (code <= 69) return 'Rain'
  if (code <= 79) return 'Snow'
  if (code <= 84) return 'Showers'
  if (code <= 94) return 'Thunderstorm'
  return 'Storm'
}

export interface WeatherCurrent {
  temperature: number
  apparent_temperature: number
  weather_code: number
  wind_speed: number
  humidity: number
}

export interface WeatherDaily {
  date: string
  temp_max: number
  temp_min: number
  weather_code: number
}

export interface WeatherData {
  current: WeatherCurrent
  daily: WeatherDaily[]
  location: string
}
