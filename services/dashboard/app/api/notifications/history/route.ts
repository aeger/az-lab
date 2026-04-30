import { NextRequest, NextResponse } from 'next/server'

const SENTINEL_URL = process.env.SENTINEL_API_URL || 'http://sentinel-api:3200'
const SENTINEL_KEY = process.env.SENTINEL_API_KEY || ''

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const params = new URLSearchParams()
  for (const [k, v] of searchParams.entries()) params.set(k, v)

  try {
    const res = await fetch(`${SENTINEL_URL}/api/notifications/history?${params}`, {
      headers: { 'X-Sentinel-Key': SENTINEL_KEY },
      next: { revalidate: 0 },
    })
    if (!res.ok) return NextResponse.json({ notifications: [], total: 0, offset: 0 })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ notifications: [], total: 0, offset: 0 })
  }
}
