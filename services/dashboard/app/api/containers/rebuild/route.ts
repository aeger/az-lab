import { NextRequest, NextResponse } from 'next/server'
import { sshExec } from '@/lib/ssh-exec'

// Mirror of CONTAINER_COMPOSE_MAP in execute_update.py
const COMPOSE_MAP: Record<string, [string, string]> = {
  'prometheus':              ['monitoring', 'prometheus'],
  'grafana':                 ['monitoring', 'grafana'],
  'node_exporter':           ['monitoring', 'node_exporter'],
  'cadvisor':                ['monitoring', 'cadvisor'],
  'blackbox':                ['monitoring', 'blackbox'],
  'snmp_exporter':           ['monitoring', 'snmp_exporter'],
  'podman_exporter':         ['monitoring', 'podman_exporter'],
  'hbbs':                    ['rustdesk', 'hbbs'],
  'hbbr':                    ['rustdesk', 'hbbr'],
  'lldap':                   ['lldap', 'lldap'],
  'authelia':                ['monitoring', 'authelia'],
  'changedetection':         ['changedetect', 'changedetection'],
  'traefik':                 ['dashboard', 'traefik'],
  'portainer':               ['portainer', 'portainer'],
  'az-dashboard':            ['dashboard', 'dashboard'],
  'uptime-kuma':             ['dashboard', 'uptime-kuma'],
  'immich-server':           ['dashboard', 'immich-server'],
  'immich-machine-learning': ['dashboard', 'immich-machine-learning'],
  'immich-redis':            ['dashboard', 'immich-redis'],
  'immich-postgres':         ['dashboard', 'immich-postgres'],
  'code-server':             ['code-server', 'code-server'],
  'webtop':                  ['webtop', 'webtop'],
  'shelfmark':               ['shelfmark', 'shelfmark'],
  'npm':                     ['npm', 'npm'],
  'audiobookshelf':          ['audiobookshelf', 'audiobookshelf'],
  'calibre-web-automated':   ['calibre-web', 'calibre-web-automated'],
  'sentinel-api':            ['sentinel', 'sentinel-api'],
  'az-gmail-mcp':            ['gmail-mcp-server', 'az-gmail-mcp'],
  'az-memory-mcp':           ['memory-mcp-server', 'memory-mcp'],
  'az-ms-smtp-relay':        ['ms-smtp-relay', 'az-ms-smtp-relay'],
}

const SERVICES_DIR = '/home/almty1/azlab/services'
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { containerName } = await req.json()

    if (!containerName || typeof containerName !== 'string' || !NAME_RE.test(containerName)) {
      return NextResponse.json({ error: 'Invalid container name' }, { status: 400 })
    }

    const mapping = COMPOSE_MAP[containerName]
    if (!mapping) {
      return NextResponse.json({ error: `No compose mapping for "${containerName}"` }, { status: 404 })
    }

    const [composeDir, serviceName] = mapping
    const composePath = `${SERVICES_DIR}/${composeDir}`

    // Pull image then recreate container via SSH to host
    try {
      await sshExec(
        `cd ${composePath} && podman-compose pull ${serviceName} && podman-compose up -d --no-deps --force-recreate ${serviceName}`,
        300_000
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return NextResponse.json({ error: `Update failed: ${msg}` }, { status: 500 })
    }

    return NextResponse.json({ success: true, container: containerName, service: serviceName })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
