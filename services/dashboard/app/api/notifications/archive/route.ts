import { NextResponse } from 'next/server'

const SENTINEL_URL = process.env.SENTINEL_API_URL || 'http://sentinel-api:3200'
const SENTINEL_KEY = process.env.SENTINEL_API_KEY || ''

export async function DELETE() {
  try {
    const res = await fetch(`${SENTINEL_URL}/api/notifications/archive`, {
      method: 'DELETE',
      headers: { 'X-Sentinel-Key': SENTINEL_KEY },
    })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ ok: false, error: 'Sentinel unavailable' }, { status: 503 })
  }
}
