import { NextRequest, NextResponse } from 'next/server'

const SENTINEL_URL = process.env.SENTINEL_API_URL || 'http://sentinel-api:3200'
const SENTINEL_KEY = process.env.SENTINEL_API_KEY || ''

async function handleRead(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const res = await fetch(`${SENTINEL_URL}/api/notifications/${id}/read`, {
      method: 'POST',
      headers: { 'X-Sentinel-Key': SENTINEL_KEY },
    })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ success: false }, { status: 503 })
  }
}

export const POST = handleRead
export const PATCH = handleRead
