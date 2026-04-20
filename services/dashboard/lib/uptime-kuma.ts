export interface Monitor {
  id: number
  name: string
  status: 'up' | 'down' | 'pending' | 'maintenance'
  uptime: number
  ping: number | null
}

export async function fetchUptimeKuma(): Promise<Monitor[]> {
  const baseUrl = process.env.UPTIME_KUMA_URL
  if (!baseUrl) return []

  try {
    const [statusRes, heartbeatRes] = await Promise.all([
      fetch(`${baseUrl}/api/status-page/default`, { next: { revalidate: 60 } }),
      fetch(`${baseUrl}/api/status-page/heartbeat/default`, { next: { revalidate: 60 } }),
    ])

    if (!statusRes.ok) return []

    const data = await statusRes.json()

    let heartbeatMap: Record<string, { status: number; ping: number }[]> = {}
    let uptimeMap: Record<string, number> = {}
    if (heartbeatRes.ok) {
      const hbData = await heartbeatRes.json()
      heartbeatMap = hbData.heartbeatList ?? {}
      uptimeMap = hbData.uptimeList ?? {}
    }

    const monitorList: Monitor[] = []

    if (data.publicGroupList) {
      for (const group of data.publicGroupList) {
        for (const monitor of group.monitorList) {
          const beats = heartbeatMap[String(monitor.id)] ?? []
          const lastBeat = beats[beats.length - 1]
          const statusNum: number = lastBeat?.status ?? 2

          let status: Monitor['status'] = 'pending'
          if (statusNum === 1) status = 'up'
          else if (statusNum === 0) status = 'down'
          else if (statusNum === 3) status = 'maintenance'

          const uptimeKey = `${monitor.id}_24`
          const uptime24h = uptimeMap[uptimeKey] ?? 0

          monitorList.push({
            id: monitor.id,
            name: monitor.name,
            status,
            uptime: Math.round(uptime24h * 10000) / 100,
            ping: lastBeat?.ping ?? null,
          })
        }
      }
    }

    return monitorList
  } catch {
    return []
  }
}
