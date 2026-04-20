import { NextRequest, NextResponse } from 'next/server'

const SENTINEL_URL = process.env.SENTINEL_API_URL || 'http://sentinel-api:3200'
const SENTINEL_KEY = process.env.SENTINEL_API_KEY || ''

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  try {
    const res = await fetch(`${SENTINEL_URL}/api/notifications/read-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sentinel-Key': SENTINEL_KEY },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ success: false }, { status: 503 })
  }
}
