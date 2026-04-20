import LabSubNav from '@/components/lab/LabSubNav'
import HostMetrics from '@/components/lab/HostMetrics'
import LabMonitor from '@/components/lab/LabMonitor'
import NetworkStats from '@/components/lab/NetworkStats'
import ContainerMetrics from '@/components/lab/ContainerMetrics'

export const dynamic = 'force-dynamic'

const card = 'relative card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4'

export default function MonitorPage() {
  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <LabSubNav />

      <div className={`${card} mb-4`}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Host Metrics</h2>
        <HostMetrics />
      </div>

      <div className={`${card} mb-4`}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Services</h2>
        <LabMonitor />
      </div>

      <div className={`${card} mb-4`}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Containers</h2>
        <ContainerMetrics />
      </div>

      <div className={card}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Network</h2>
        <NetworkStats />
      </div>
    </div>
  )
}
