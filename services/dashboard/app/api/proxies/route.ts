import { NextRequest, NextResponse } from 'next/server'
import {
  listProxies,
  writeProxy,
  proxyExists,
  isValidName,
  isValidHostname,
  isValidUrl,
  type ProxyConfig,
} from '@/lib/traefik-proxies'
import { upsertDnsRecord } from '@/lib/cloudflare-dns'

export async function GET() {
  const proxies = listProxies()
  return NextResponse.json({ proxies })
}

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { name, hostname, backendUrl, lanOnly, auth, tls, staticIp } = body as Partial<ProxyConfig>

    if (!name || !isValidName(name)) {
      return NextResponse.json({ error: 'Invalid name — use lowercase letters, numbers, and hyphens' }, { status: 400 })
    }
    if (!hostname || !isValidHostname(hostname)) {
      return NextResponse.json({ error: 'Invalid hostname' }, { status: 400 })
    }
    if (!backendUrl || !isValidUrl(backendUrl)) {
      return NextResponse.json({ error: 'Invalid backend URL' }, { status: 400 })
    }
    if (proxyExists(name)) {
      return NextResponse.json({ error: `Proxy "${name}" already exists` }, { status: 409 })
    }

    const cfg: ProxyConfig = {
      name,
      hostname,
      backendUrl,
      lanOnly: lanOnly ?? true,
      auth: auth ?? false,
      tls: tls ?? true,
      staticIp: staticIp || '70.167.221.51',
    }

    writeProxy(cfg)

    // Create DNS record (fire and forget — Traefik cert still works with existing wildcard)
    let dnsOk = false
    try {
      dnsOk = await upsertDnsRecord(hostname, cfg.staticIp)
    } catch {
      // Non-fatal — proxy file is written, DNS can be manually fixed
    }

    return NextResponse.json({ success: true, dns: dnsOk })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
