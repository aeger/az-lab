import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

export interface TraefikRouter {
  name: string
  hostname: string
  service: string
  provider: string   // 'docker' | 'file'
  auth: boolean
  lanOnly: boolean
  total_requests: number
  req_per_min: number
  errors_4xx: number
  errors_5xx: number
  redirects: number
}

async function promQuery(query: string): Promise<{ metric: Record<string, string>; value: string }[]> {
  const baseUrl = process.env.PROMETHEUS_URL
  if (!baseUrl) return []
  try {
    const res = await fetch(`${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`, {
      next: { revalidate: 30 },
    })
    const data = await res.json()
    return (data.data?.result ?? []).map((r: { metric: Record<string, string>; value: [number, string] }) => ({
      metric: r.metric,
      value: r.value[1],
    }))
  } catch {
    return []
  }
}

// Parse hostname from Traefik rule like Host(`foo.az-lab.dev`)
function parseHost(rule: string): string {
  const m = rule.match(/Host\(`([^`]+)`\)/)
  return m ? m[1] : rule
}

// Read hostnames from the dynamic YAML files
function readDynamicRouters(): Record<string, { hostname: string; auth: boolean; lanOnly: boolean }> {
  const dir = process.env.TRAEFIK_DYNAMIC_DIR || '/traefik-dynamic'
  const result: Record<string, { hostname: string; auth: boolean; lanOnly: boolean }> = {}
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8')
        const parsed = yaml.load(content) as Record<string, unknown>
        const routers = (parsed?.http as Record<string, unknown>)?.routers as Record<string, Record<string, unknown>> | undefined
        if (!routers) continue
        for (const [name, cfg] of Object.entries(routers)) {
          const rule = (cfg.rule as string) ?? ''
          const middlewares = (cfg.middlewares as string[]) ?? []
          result[name] = {
            hostname: parseHost(rule),
            auth: middlewares.some(m => m.includes('authelia')),
            lanOnly: middlewares.some(m => m.includes('lan-allow') || m.includes('lan-allow@file')),
          }
        }
      } catch { /* skip malformed files */ }
    }
  } catch { /* dir not available */ }
  return result
}

export async function GET() {
  const [totalRows, rateRows, errorRows] = await Promise.all([
    promQuery('sum by (router,service) (traefik_router_requests_total)'),
    promQuery('sum by (router) (irate(traefik_router_requests_total[5m])) * 60'),
    promQuery('sum by (router,code) (traefik_router_requests_total{code!~"2.."})')
  ])

  const dynamic = readDynamicRouters()

  // Build totals map
  const totalMap: Record<string, { total: number; service: string }> = {}
  for (const r of totalRows) {
    const name = r.metric.router
    if (!name) continue
    totalMap[name] = {
      total: parseFloat(r.value),
      service: r.metric.service ?? '',
    }
  }

  // Rate map
  const rateMap: Record<string, number> = {}
  for (const r of rateRows) {
    if (r.metric.router) rateMap[r.metric.router] = parseFloat(r.value)
  }

  // Error maps
  const err4xx: Record<string, number> = {}
  const err5xx: Record<string, number> = {}
  const redirects: Record<string, number> = {}
  for (const r of errorRows) {
    const name = r.metric.router
    const code = parseInt(r.metric.code ?? '0')
    const v = parseFloat(r.value)
    if (!name) continue
    if (code >= 400 && code < 500) err4xx[name] = (err4xx[name] ?? 0) + v
    else if (code >= 500) err5xx[name] = (err5xx[name] ?? 0) + v
    else if (code >= 300 && code < 400) redirects[name] = (redirects[name] ?? 0) + v
  }

  // Merge all known routers
  const allNames = new Set([...Object.keys(totalMap), ...Object.keys(dynamic)])

  const routers: TraefikRouter[] = Array.from(allNames)
    .filter(n => !n.startsWith('traefik@') && n !== 'traefik')
    .map(name => {
      const [baseName, provider] = name.split('@')
      const dynInfo = dynamic[baseName] ?? dynamic[name]
      const total = totalMap[name]
      return {
        name: baseName ?? name,
        hostname: dynInfo?.hostname ?? '',
        service: total?.service ?? name,
        provider: provider ?? 'file',
        auth: dynInfo?.auth ?? false,
        lanOnly: dynInfo?.lanOnly ?? false,
        total_requests: total?.total ?? 0,
        req_per_min: Math.round((rateMap[name] ?? 0) * 10) / 10,
        errors_4xx: Math.round(err4xx[name] ?? 0),
        errors_5xx: Math.round(err5xx[name] ?? 0),
        redirects: Math.round(redirects[name] ?? 0),
      }
    })
    .sort((a, b) => b.total_requests - a.total_requests)

  return NextResponse.json({ routers })
}
