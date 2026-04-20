import { NextResponse } from 'next/server'
import { fetchWeather } from '@/lib/weather'

export async function GET() {
  try {
    const data = await fetchWeather()
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 })
  }
}
