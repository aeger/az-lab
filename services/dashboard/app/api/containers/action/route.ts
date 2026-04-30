import { NextRequest, NextResponse } from 'next/server'
import { containerAction, type ContainerAction } from '@/lib/portainer'

const VALID_ACTIONS: ContainerAction[] = ['start', 'stop', 'restart']
const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/

export async function POST(req: NextRequest) {
  // Auth is enforced at Traefik level (lan-allow@file middleware).
  // Cookie presence check as basic sanity — real auth is at the reverse proxy.
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { endpointId, containerId, action } = await req.json()

    if (typeof endpointId !== 'number' || !Number.isInteger(endpointId) || endpointId < 1) {
      return NextResponse.json({ error: 'Invalid endpointId' }, { status: 400 })
    }

    if (typeof containerId !== 'string' || !CONTAINER_ID_RE.test(containerId)) {
      return NextResponse.json({ error: 'Invalid containerId' }, { status: 400 })
    }

    if (!VALID_ACTIONS.includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const ok = await containerAction(endpointId, containerId, action)
    if (!ok) {
      return NextResponse.json({ error: 'Action failed' }, { status: 502 })
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
