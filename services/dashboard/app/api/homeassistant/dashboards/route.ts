import { NextRequest, NextResponse } from 'next/server'
import { getHADashboards, saveHADashboards } from '@/lib/ha-dashboards'
import type { HADashboardEntry } from '@/lib/ha-dashboards'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ dashboards: getHADashboards() })
}

export async function POST(req: NextRequest) {
  let body: { dashboards?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.dashboards)) {
    return NextResponse.json({ error: 'dashboards must be an array' }, { status: 400 })
  }

  if (body.dashboards.length === 0) {
    return NextResponse.json({ error: 'At least one dashboard is required' }, { status: 400 })
  }

  if (body.dashboards.length > 20) {
    return NextResponse.json({ error: 'Maximum of 20 dashboards allowed' }, { status: 400 })
  }

  const dashboards: HADashboardEntry[] = []
  for (const item of body.dashboards) {
    if (typeof item !== 'object' || item === null) {
      return NextResponse.json({ error: 'Each dashboard must be an object' }, { status: 400 })
    }
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const path = typeof item.path === 'string' ? item.path.trim() : ''

    if (!title) return NextResponse.json({ error: 'Each dashboard must have a title' }, { status: 400 })
    if (!path) return NextResponse.json({ error: 'Each dashboard must have a path' }, { status: 400 })

    dashboards.push({ title, path })
  }

  saveHADashboards(dashboards)
  return NextResponse.json({ dashboards: getHADashboards() })
}
