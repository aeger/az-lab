import { NextRequest, NextResponse } from 'next/server'
import { sshExec } from '@/lib/ssh-exec'

// Stack = one compose directory that contains multiple dependent services
export const STACK_DEFINITIONS: Record<string, { path: string; containers: string[]; label: string }> = {
  immich: {
    path: '/home/almty1/azlab/services/dashboard',
    label: 'Immich',
    containers: ['immich-server', 'immich-machine-learning', 'immich-redis', 'immich-postgres'],
  },
  monitoring: {
    path: '/home/almty1/azlab/services/monitoring',
    label: 'Monitoring',
    containers: ['prometheus', 'grafana', 'node_exporter', 'cadvisor', 'blackbox', 'snmp_exporter', 'podman_exporter'],
  },
  rustdesk: {
    path: '/home/almty1/azlab/services/rustdesk',
    label: 'RustDesk',
    containers: ['hbbs', 'hbbr'],
  },
  dashboard: {
    path: '/home/almty1/azlab/services/dashboard',
    label: 'Dashboard',
    containers: ['az-dashboard', 'uptime-kuma'],
  },
}

// Return which stack a container belongs to (null if standalone)
export function getContainerStack(name: string): string | null {
  for (const [stackName, def] of Object.entries(STACK_DEFINITIONS)) {
    if (def.containers.includes(name)) return stackName
  }
  return null
}

export async function GET() {
  return NextResponse.json({ stacks: STACK_DEFINITIONS })
}

export async function POST(req: NextRequest) {
  try {
    const { stackName } = await req.json()

    if (!stackName || typeof stackName !== 'string' || !/^[a-z0-9-]+$/.test(stackName)) {
      return NextResponse.json({ error: 'Invalid stack name' }, { status: 400 })
    }

    const stack = STACK_DEFINITIONS[stackName]
    if (!stack) {
      return NextResponse.json({ error: `Unknown stack: ${stackName}` }, { status: 404 })
    }

    const composePath = stack.path

    // Pull all images and recreate stack via SSH to host
    try {
      await sshExec(`cd ${composePath} && podman-compose pull && podman-compose up -d`, 480_000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return NextResponse.json({ error: `Stack update failed: ${msg}` }, { status: 500 })
    }

    return NextResponse.json({ success: true, stack: stackName, containers: stack.containers })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
