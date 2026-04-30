import { NextResponse } from 'next/server'
import { fetchHostMetrics } from '@/lib/prometheus'
import { getConfig } from '@/lib/config'

export async function GET() {
  const config = getConfig()
  try {
    const metrics = await fetchHostMetrics(config.lab.hosts)
    return NextResponse.json({ metrics })
  } catch {
    return NextResponse.json({ metrics: [] })
  }
}
