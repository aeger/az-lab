import { NextRequest, NextResponse } from 'next/server'
import {
  getProxy,
  writeProxy,
  deleteProxy,
  isValidName,
  isValidHostname,
  isValidUrl,
  type ProxyConfig,
} from '@/lib/traefik-proxies'
import { upsertDnsRecord, deleteDnsRecord } from '@/lib/cloudflare-dns'

type Params = { params: Promise<{ name: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const { name } = await params
  if (!isValidName(name)) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
  }
  const proxy = getProxy(name)
  if (!proxy) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ proxy })
}

export async function PUT(req: NextRequest, { params }: Params) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { name } = await params
  if (!isValidName(name)) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
  }

  const existing = getProxy(name)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const body = await req.json()
    const { hostname, backendUrl, lanOnly, auth, tls, staticIp } = body as Partial<ProxyConfig>

    if (hostname && !isValidHostname(hostname)) {
      return NextResponse.json({ error: 'Invalid hostname' }, { status: 400 })
    }
    if (backendUrl && !isValidUrl(backendUrl)) {
      return NextResponse.json({ error: 'Invalid backend URL' }, { status: 400 })
    }

    const updated: ProxyConfig = {
      name,
      hostname: hostname ?? existing.hostname,
      backendUrl: backendUrl ?? existing.backendUrl,
      lanOnly: lanOnly ?? existing.lanOnly,
      auth: auth ?? existing.auth,
      tls: tls ?? existing.tls,
      staticIp: staticIp ?? existing.staticIp,
    }

    writeProxy(updated)

    // Update DNS if hostname or IP changed
    let dnsOk = false
    if (updated.hostname !== existing.hostname || updated.staticIp !== existing.staticIp) {
      try {
        if (updated.hostname !== existing.hostname) {
          await deleteDnsRecord(existing.hostname)
        }
        dnsOk = await upsertDnsRecord(updated.hostname, updated.staticIp)
      } catch {
        // Non-fatal
      }
    } else {
      dnsOk = true
    }

    return NextResponse.json({ success: true, dns: dnsOk })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { name } = await params
  if (!isValidName(name)) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
  }

  const existing = getProxy(name)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Check for deleteDns query param
  const url = new URL(req.url)
  const deleteDns = url.searchParams.get('deleteDns') === 'true'

  const deleted = deleteProxy(name)
  if (!deleted) return NextResponse.json({ error: 'Delete failed' }, { status: 500 })

  let dnsDeleted = false
  if (deleteDns) {
    try {
      dnsDeleted = await deleteDnsRecord(existing.hostname)
    } catch {
      // Non-fatal
    }
  }

  return NextResponse.json({ success: true, dnsDeleted })
}
