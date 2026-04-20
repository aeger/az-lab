import { NextResponse } from 'next/server'
import { fetchAdGuardStats } from '@/lib/adguard'
import { getConfig } from '@/lib/config'

export async function GET() {
  const config = getConfig()
  try {
    const stats = await fetchAdGuardStats(config.lab.adguard_url)
    return NextResponse.json(stats ?? { error: 'Not configured' })
  } catch {
    return NextResponse.json({ error: 'Unavailable' }, { status: 503 })
  }
}
