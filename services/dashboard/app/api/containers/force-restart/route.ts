import { NextRequest, NextResponse } from 'next/server'
import { sshExec } from '@/lib/ssh-exec'

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

// Containers that are part of a multi-container stack — force-remove all peers before restarting
const STACK_GROUPS: Record<string, string[]> = {
  'immich-server':           ['immich-server', 'immich-machine-learning', 'immich-redis', 'immich-postgres'],
  'immich-machine-learning': ['immich-server', 'immich-machine-learning', 'immich-redis', 'immich-postgres'],
  'immich-redis':            ['immich-server', 'immich-machine-learning', 'immich-redis', 'immich-postgres'],
  'immich-postgres':         ['immich-server', 'immich-machine-learning', 'immich-redis', 'immich-postgres'],
}

// Services to bring up when restarting a stack group (order matters)
const STACK_SERVICES: Record<string, string[]> = {
  'immich-server': ['immich-postgres', 'immich-redis', 'immich-machine-learning', 'immich-server'],
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

    const [composeDir] = mapping
    const composePath = `${SERVICES_DIR}/${composeDir}`

    const stackKey = Object.keys(STACK_GROUPS).find((k) => STACK_GROUPS[k].includes(containerName))
    if (stackKey) {
      // Multi-container stack — remove all peers then bring up in order
      const peers = STACK_GROUPS[stackKey]
      const services = (STACK_SERVICES[stackKey] ?? peers).join(' ')
      const rmAll = peers.map((p) => `podman rm -f ${p} 2>/dev/null || true`).join(' && ')
      await sshExec(`${rmAll} && cd ${composePath} && podman-compose up -d ${services}`, 120_000)
    } else {
      const [, serviceName] = mapping
      await sshExec(
        `podman rm -f ${containerName} 2>/dev/null || true && cd ${composePath} && podman-compose up -d ${serviceName}`,
        120_000
      )
    }

    return NextResponse.json({ success: true, container: containerName })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Force restart failed: ${msg}` }, { status: 500 })
  }
}
