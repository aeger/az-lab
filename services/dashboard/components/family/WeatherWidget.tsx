'use client'

import { useEffect, useState } from 'react'
import { weatherCodeToIcon, weatherCodeToLabel } from '@/lib/weather-utils'
import type { WeatherData } from '@/lib/weather-utils'

const CACHE_KEY = 'az_weather_cache'
const CACHE_TTL = 10 * 60 * 1000 // 10 min — only skip network fetch if very fresh

function readCache(): WeatherData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { data, ts } = JSON.parse(raw)
    return data ?? null
  } catch { return null }
}

function writeCache(data: WeatherData) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })) } catch {}
}

function cacheAge(): number {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return Infinity
    return Date.now() - (JSON.parse(raw).ts ?? 0)
  } catch { return Infinity }
}

export default function WeatherWidget() {
  const [data, setData] = useState<WeatherData | null>(() => readCache())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    // If cache is fresh enough, skip the network hit
    if (cacheAge() < CACHE_TTL && data) return

    setRefreshing(true)
    fetch('/api/weather')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(!data) } // only show error if we have no cached data
        else { setData(d); writeCache(d); setError(false) }
      })
      .catch(() => { if (!data) setError(true) })
      .finally(() => setRefreshing(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  if (error && !data) return (
    <div className="h-full flex items-center justify-center text-zinc-500 text-sm">Weather unavailable</div>
  )

  if (!data) return (
    <div className="h-full flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div className="text-6xl leading-none">{weatherCodeToIcon(data.current.weather_code)}</div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <div className="text-4xl font-light text-white">{data.current.temperature}°F</div>
            {refreshing && <div className="w-3 h-3 border border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />}
          </div>
          <div className="text-sm text-zinc-400">{weatherCodeToLabel(data.current.weather_code)}</div>
          <div className="text-xs text-zinc-500 mt-1">
            Feels {data.current.apparent_temperature}° · {data.current.humidity}% humidity · {data.current.wind_speed} mph
          </div>
          <div className="text-xs text-zinc-500">{data.location}</div>
        </div>
      </div>

      <div className="flex gap-2 mt-auto">
        {data.daily.map((day) => {
          const d = new Date(day.date + 'T12:00:00')
          return (
            <div key={day.date} className="flex-1 flex flex-col items-center gap-1 bg-zinc-800/50 rounded-lg p-2">
              <div className="text-xs text-zinc-400">{DAYS[d.getDay()]}</div>
              <div className="text-lg">{weatherCodeToIcon(day.weather_code)}</div>
              <div className="text-xs text-white">{day.temp_max}°</div>
              <div className="text-xs text-zinc-500">{day.temp_min}°</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
