interface StatusBadgeProps {
  status: 'up' | 'down' | 'pending' | 'maintenance' | 'running' | 'stopped' | string
  label?: string
}

const STATUS_STYLES: Record<string, string> = {
  up: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  running: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  down: 'bg-red-500/20 text-red-400 border-red-500/30',
  stopped: 'bg-red-500/20 text-red-400 border-red-500/30',
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  maintenance: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
}

const STATUS_DOT: Record<string, string> = {
  up: 'bg-emerald-400',
  running: 'bg-emerald-400',
  down: 'bg-red-400',
  stopped: 'bg-red-400',
  pending: 'bg-yellow-400',
  maintenance: 'bg-blue-400',
}

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? 'bg-zinc-700 text-zinc-400 border-zinc-600'
  const dot = STATUS_DOT[status] ?? 'bg-zinc-500'

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium ${style}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${status === 'down' ? 'animate-pulse' : ''}`} />
      {label ?? status}
    </span>
  )
}
