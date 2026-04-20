export interface AdGuardStats {
  total_dns_queries: number
  blocked_filtering: number
  blocked_percent: number
  avg_processing_time_ms: number
  top_queried_domains: { name: string; count: number }[]
  top_blocked_domains: { name: string; count: number }[]
  top_clients: { name: string; count: number }[]
  protection_enabled: boolean
  num_filter_lists: number
  num_rules: number
}

export async function fetchAdGuardStats(configUrl?: string): Promise<AdGuardStats | null> {
  const baseUrl = process.env.ADGUARD_URL || configUrl
  const username = process.env.ADGUARD_USERNAME
  const password = process.env.ADGUARD_PASSWORD

  if (!baseUrl) return null

  const headers: Record<string, string> = {}
  if (username && password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  }

  try {
    const [statsRes, statusRes, filteringRes, clientsRes] = await Promise.all([
      fetch(`${baseUrl}/control/stats`, { headers, next: { revalidate: 60 } }),
      fetch(`${baseUrl}/control/status`, { headers, next: { revalidate: 60 } }),
      fetch(`${baseUrl}/control/filtering/status`, { headers, next: { revalidate: 300 } }),
      fetch(`${baseUrl}/control/clients`, { headers, next: { revalidate: 300 } }),
    ])

    if (!statsRes.ok) return null

    const stats = await statsRes.json()
    const status = statusRes.ok ? await statusRes.json() : {}
    const filtering = filteringRes.ok ? await filteringRes.json() : {}
    const clientsData = clientsRes.ok ? await clientsRes.json() : {}

    // Build IP/MAC → friendly name map from configured clients
    const clientNameMap = new Map<string, string>()
    for (const client of (clientsData.clients ?? [])) {
      for (const id of (client.ids ?? [])) {
        clientNameMap.set(id, client.name)
      }
    }

    const total = stats.num_dns_queries ?? 0
    const blocked = stats.num_blocked_filtering ?? 0
    const avgTime = stats.avg_processing_time ?? 0

    const filterLists = filtering.filters ?? []
    const numRules = filterLists.reduce((sum: number, f: { rules_count?: number }) => sum + (f.rules_count ?? 0), 0)

    return {
      total_dns_queries: total,
      blocked_filtering: blocked,
      blocked_percent: total > 0 ? Math.round((blocked / total) * 100) : 0,
      avg_processing_time_ms: Math.round(avgTime * 1000),
      top_queried_domains: (stats.top_queried_domains ?? []).slice(0, 5).map((d: Record<string, number>) => {
        const [name, count] = Object.entries(d)[0]
        return { name, count }
      }),
      top_blocked_domains: (stats.top_blocked_domains ?? []).slice(0, 5).map((d: Record<string, number>) => {
        const [name, count] = Object.entries(d)[0]
        return { name, count }
      }),
      top_clients: (stats.top_clients ?? []).slice(0, 5).map((c: Record<string, number>) => {
        const [ip, count] = Object.entries(c)[0] as [string, number]
        return { name: clientNameMap.get(ip) ?? ip, count }
      }),
      protection_enabled: status.protection_enabled ?? false,
      num_filter_lists: filterLists.length,
      num_rules: numRules,
    }
  } catch {
    return null
  }
}
