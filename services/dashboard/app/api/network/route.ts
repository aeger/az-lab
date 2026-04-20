import { NextResponse } from 'next/server'

export interface NetworkStats {
  interfaces: Array<{
    device: string
    rx_bytes_per_sec: number
    tx_bytes_per_sec: number
  }>
  wan_checks: Array<{
    name: string
    ok: boolean
    latency_ms: number | null
  }>
}

async function promInstantQuery(baseUrl: string, query: string): Promise<Array<{ metric: Record<string, string>; value: number }>> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query }),
      next: { revalidate: 30 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.data?.result ?? []).map((r: { metric: Record<string, string>; value: [number, string] }) => ({
      metric: r.metric,
      value: parseFloat(r.value?.[1] ?? '0'),
    }))
  } catch {
    return []
  }
}

async function checkUrl(name: string, url: string): Promise<{ name: string; ok: boolean; latency_ms: number | null }> {
  const start = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    return { name, ok: res.ok || res.status < 500, latency_ms: Date.now() - start }
  } catch {
    return { name, ok: false, latency_ms: null }
  }
}

export async function GET() {
  const promUrl = process.env.PROMETHEUS_URL

  // WAN checks — run regardless of Prometheus
  const wan_checks = await Promise.all([
    checkUrl('Cloudflare', 'https://1.1.1.1/cdn-cgi/trace'),
    checkUrl('Google', 'https://www.google.com'),
    checkUrl('GitHub', 'https://github.com'),
  ])

  if (!promUrl) {
    return NextResponse.json({ interfaces: [], wan_checks })
  }

  // Per-interface bandwidth (exclude loopback, virtual, container interfaces)
  const skipPattern = /^(lo|veth|br-|docker|cni|flannel|calico|tunl|ovs)/
  const [rxResults, txResults] = await Promise.all([
    promInstantQuery(promUrl, `irate(node_network_receive_bytes_total{device!="lo"}[5m])`),
    promInstantQuery(promUrl, `irate(node_network_transmit_bytes_total{device!="lo"}[5m])`),
  ])

  const rxMap: Record<string, number> = {}
  for (const r of rxResults) {
    const dev = r.metric.device ?? ''
    if (!skipPattern.test(dev)) rxMap[dev] = (rxMap[dev] ?? 0) + r.value
  }
  const txMap: Record<string, number> = {}
  for (const r of txResults) {
    const dev = r.metric.device ?? ''
    if (!skipPattern.test(dev)) txMap[dev] = (txMap[dev] ?? 0) + r.value
  }

  const devices = [...new Set([...Object.keys(rxMap), ...Object.keys(txMap)])]
  const interfaces = devices
    .map((dev) => ({
      device: dev,
      rx_bytes_per_sec: rxMap[dev] ?? 0,
      tx_bytes_per_sec: txMap[dev] ?? 0,
    }))
    .sort((a, b) => (b.rx_bytes_per_sec + b.tx_bytes_per_sec) - (a.rx_bytes_per_sec + a.tx_bytes_per_sec))
    .slice(0, 6)

  return NextResponse.json({ interfaces, wan_checks })
}
