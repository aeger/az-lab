import { NextResponse } from 'next/server'

const STEP = 300 // 5-min intervals → 144 points over 12h

async function promRangeQuery(baseUrl: string, query: string, start: number, end: number): Promise<[number, string][]> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/query_range`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query, start: String(start), end: String(end), step: String(STEP) }),
      next: { revalidate: 60 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.data?.result?.[0]?.values ?? []
  } catch { return [] }
}

const norm = (vals: [number, string][]) => vals.map(([t, v]) => ({ t: t * 1000, v: parseFloat(v) }))

export async function GET() {
  const baseUrl = process.env.PROMETHEUS_URL
  if (!baseUrl) return NextResponse.json({ cpu: [], ram: [], cpuModes: {}, memBreakdown: {} })

  const end = Math.floor(Date.now() / 1000)
  const start = end - 12 * 3600

  const [
    cpuValues, ramValues,
    cpuUser, cpuSystem, cpuIowait, cpuSteal,
    memTotal, memFree, memBuffers, memCached, memAvailable,
  ] = await Promise.all([
    promRangeQuery(baseUrl, `100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`, start, end),
    promRangeQuery(baseUrl, `100 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100)`, start, end),
    // CPU by mode (%)
    promRangeQuery(baseUrl, `avg(irate(node_cpu_seconds_total{mode="user"}[5m])) * 100`, start, end),
    promRangeQuery(baseUrl, `avg(irate(node_cpu_seconds_total{mode="system"}[5m])) * 100`, start, end),
    promRangeQuery(baseUrl, `avg(irate(node_cpu_seconds_total{mode="iowait"}[5m])) * 100`, start, end),
    promRangeQuery(baseUrl, `avg(irate(node_cpu_seconds_total{mode="steal"}[5m])) * 100`, start, end),
    // Memory breakdown (bytes)
    promRangeQuery(baseUrl, `node_memory_MemTotal_bytes`, start, end),
    promRangeQuery(baseUrl, `node_memory_MemFree_bytes`, start, end),
    promRangeQuery(baseUrl, `node_memory_Buffers_bytes`, start, end),
    promRangeQuery(baseUrl, `node_memory_Cached_bytes`, start, end),
    promRangeQuery(baseUrl, `node_memory_MemAvailable_bytes`, start, end),
  ])

  return NextResponse.json({
    cpu: norm(cpuValues),
    ram: norm(ramValues),
    cpuModes: {
      user:   norm(cpuUser),
      system: norm(cpuSystem),
      iowait: norm(cpuIowait),
      steal:  norm(cpuSteal),
    },
    memBreakdown: {
      total:     norm(memTotal),
      free:      norm(memFree),
      buffers:   norm(memBuffers),
      cached:    norm(memCached),
      available: norm(memAvailable),
    },
  })
}
