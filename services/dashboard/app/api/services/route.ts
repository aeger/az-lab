import { NextResponse } from 'next/server'
import { fetchUptimeKuma } from '@/lib/uptime-kuma'

export async function GET() {
  try {
    const monitors = await fetchUptimeKuma()
    return NextResponse.json({ monitors })
  } catch {
    return NextResponse.json({ monitors: [] })
  }
}
