import { NextRequest, NextResponse } from 'next/server'

const SENTINEL_URL = process.env.SENTINEL_API_URL || 'http://sentinel-api:3200'
const SENTINEL_KEY = process.env.SENTINEL_API_KEY || ''

function sentinelHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Sentinel-Key': SENTINEL_KEY,
  }
}

// GET /api/notifications — proxy to sentinel in-memory store
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const params = new URLSearchParams()

  for (const [k, v] of searchParams.entries()) params.set(k, v)

  try {
    const res = await fetch(`${SENTINEL_URL}/api/notifications?${params}`, {
      headers: sentinelHeaders(),
      next: { revalidate: 0 },
    })
    if (!res.ok) {
      console.error(`[notifications] Sentinel returned ${res.status}`)
      return NextResponse.json({ notifications: [], unreadCount: 0, criticalCount: 0 })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ notifications: [], unreadCount: 0, criticalCount: 0 })
  }
}

// POST /api/notifications — mark-read or push external notification
export async function POST(req: NextRequest) {
  const body = await req.json()

  try {
    const res = await fetch(`${SENTINEL_URL}/api/notifications`, {
      method: 'POST',
      headers: sentinelHeaders(),
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Sentinel unavailable' }, { status: 503 })
  }
}
