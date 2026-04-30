import Link from 'next/link'
import HostMetrics from '@/components/lab/HostMetrics'
import LabMonitor from '@/components/lab/LabMonitor'
import AuthIndicator from '@/components/shared/AuthIndicator'
import RefreshButton from '@/components/lab/RefreshButton'
import SecurityWidget from '@/components/lab/SecurityWidget'
import AgentHealthBanner from '@/components/shared/AgentHealthBanner'
import AgentHealthCard from '@/components/lab/AgentHealthCard'
import HostMetricsCharts from '@/components/lab/HostMetricsCharts'
import ToolPills from '@/components/lab/ToolPills'
import StatusPills from '@/components/lab/StatusPills'

export const dynamic = 'force-dynamic'

const card = 'relative card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4'

function ExpandLink({ href, label = '↗ expand' }: { href: string; label?: string }) {
  return (
    <Link
      href={href}
      className="text-[10px] font-semibold text-zinc-600 hover:text-zinc-300 uppercase tracking-widest transition-colors"
    >
      {label}
    </Link>
  )
}


export default function LabPage() {
  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <AgentHealthBanner />

      {/* Page action bar */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        {/* Tool shortcuts — wraps to second row when crowded */}
        <div className="flex items-center gap-2 flex-wrap">
          <ToolPills />
        </div>
        {/* Status pills + auth — grouped right, always justified right */}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap ml-auto">
          <StatusPills />
          <AuthIndicator />
          <RefreshButton />
        </div>
      </div>

      {/* Host Metrics + Charts */}
      <div className={`${card} mb-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">Host Metrics</h2>
          <ExpandLink href="/lab/monitor" />
        </div>
        <HostMetrics />
        <HostMetricsCharts />
      </div>

      {/* Lab Monitor */}
      <div className={`${card} mb-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">Lab Monitor</h2>
          <ExpandLink href="/lab/monitor" />
        </div>
        <LabMonitor />
      </div>

      {/* Agent Health */}
      <div className={`${card} overflow-hidden mb-4`}>
        <AgentHealthCard />
      </div>

      {/* Security */}
      <div id="security" className={`${card} mb-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">Security</h2>
          <ExpandLink href="/lab/security" />
        </div>
        <SecurityWidget />
      </div>

    </div>
  )
}
