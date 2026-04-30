export interface HostMetrics {
  name: string
  instance: string
  cpu_percent: number | null
  ram_used_percent: number | null
  ram_total_gb: number | null
  ram_used_gb: number | null
  disk_used_percent: number | null
  disk_total_gb: number | null
  disk_used_gb: number | null
  net_rx_bytes: number | null
  net_tx_bytes: number | null
  uptime_days: number | null
  load_1m: number | null
}

async function promQuery(baseUrl: string, query: string): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query }),
      next: { revalidate: 30 },
    })

    if (!res.ok) return {}

    const data = await res.json()
    const result: Record<string, number> = {}

    for (const item of data.data?.result ?? []) {
      const instance = item.metric?.instance ?? 'unknown'
      result[instance] = parseFloat(item.value?.[1] ?? '0')
    }

    return result
  } catch {
    return {}
  }
}

export async function fetchHostMetrics(hosts: { name: string; node_exporter_instance: string }[]): Promise<HostMetrics[]> {
  const baseUrl = process.env.PROMETHEUS_URL
  if (!baseUrl) {
    return hosts.map((h) => ({
      name: h.name, instance: h.node_exporter_instance,
      cpu_percent: null, ram_used_percent: null, ram_total_gb: null, ram_used_gb: null,
      disk_used_percent: null, disk_total_gb: null, disk_used_gb: null,
      net_rx_bytes: null, net_tx_bytes: null, uptime_days: null, load_1m: null,
    }))
  }

  const [cpuData, ramData, ramTotalData, ramUsedData, diskData, diskTotalData, diskUsedData, netRxData, netTxData, uptimeData, loadData] = await Promise.all([
    promQuery(baseUrl, `100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`),
    promQuery(baseUrl, `100 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100)`),
    promQuery(baseUrl, `node_memory_MemTotal_bytes`),
    promQuery(baseUrl, `node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes`),
    promQuery(baseUrl, `100 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"} * 100)`),
    promQuery(baseUrl, `node_filesystem_size_bytes{mountpoint="/"}`),
    promQuery(baseUrl, `node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}`),
    promQuery(baseUrl, `irate(node_network_receive_bytes_total{device!="lo"}[5m])`),
    promQuery(baseUrl, `irate(node_network_transmit_bytes_total{device!="lo"}[5m])`),
    promQuery(baseUrl, `(time() - node_boot_time_seconds) / 86400`),
    promQuery(baseUrl, `node_load1`),
  ])

  const toGB = (v: number | undefined) => v != null ? Math.round(v / 1073741824 * 10) / 10 : null
  const round1 = (v: number | undefined) => v != null ? Math.round(v * 10) / 10 : null

  return hosts.map((h) => ({
    name: h.name,
    instance: h.node_exporter_instance,
    cpu_percent: round1(cpuData[h.node_exporter_instance]),
    ram_used_percent: round1(ramData[h.node_exporter_instance]),
    ram_total_gb: toGB(ramTotalData[h.node_exporter_instance]),
    ram_used_gb: toGB(ramUsedData[h.node_exporter_instance]),
    disk_used_percent: round1(diskData[h.node_exporter_instance]),
    disk_total_gb: toGB(diskTotalData[h.node_exporter_instance]),
    disk_used_gb: toGB(diskUsedData[h.node_exporter_instance]),
    net_rx_bytes: netRxData[h.node_exporter_instance] ?? null,
    net_tx_bytes: netTxData[h.node_exporter_instance] ?? null,
    uptime_days: round1(uptimeData[h.node_exporter_instance]),
    load_1m: round1(loadData[h.node_exporter_instance]),
  }))
}
