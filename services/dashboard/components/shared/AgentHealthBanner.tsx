'use client'

import { useEffect, useState } from 'react'

interface AgentHealth {
  agent: string
  status: string
  last_heartbeat: string | null
  prompt_count: number
  last_restart: string | null
  restart_count_hour: number
  breaker_tripped: boolean
  metadata: Record<string, unknown>
}

const STATUS_CONFIG: Record<string, { bg: string; border: string; text: string; dot: string; pulse: boolean }> = {
  critical: {
    bg: 'bg-red-500/10',
    border: 'border-red-500/40',
    text: 'text-red-400',
    dot: 'bg-red-400',
    pulse: true,
  },
  degraded: {
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/40',
    text: 'text-yellow-400',
    dot: 'bg-yellow-400',
    pulse: true,
  },
  restarting: {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/40',
    text: 'text-blue-400',
    dot: 'bg-blue-400',
    pulse: true,
  },
  down: {
    bg: 'bg-red-500/10',
    border: 'border-red-500/40',
    text: 'text-red-400',
    dot: 'bg-red-400',
    pulse: true,
  },
}

function formatAge(isoDate: string | null): string {
  if (!isoDate) return 'never'
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function getMessage(agent: AgentHealth): string {
  const name = agent.agent.charAt(0).toUpperCase() + agent.agent.slice(1)
  switch (agent.status) {
    case 'critical':
      return agent.breaker_tripped
        ? `${name} is unresponsive — circuit breaker tripped. Manual restart needed.`
        : `${name} is unresponsive — intervention required.`
    case 'degraded':
      return `${name} is responding slowly — monitoring (last heartbeat: ${formatAge(agent.last_heartbeat)})`
    case 'restarting':
      return `${name} is restarting...`
    case 'down':
      return `${name} is down — systemd restart pending.`
    default:
      return `${name}: ${agent.status}`
  }
}

export default function AgentHealthBanner() {
  const [unhealthy, setUnhealthy] = useState<AgentHealth[]>([])

  useEffect(() => {
    let mounted = true

    async function poll() {
      try {
        const res = await fetch('/api/agent-health')
        if (!res.ok) return
        const data = await res.json()
        if (mounted) {
          setUnhealthy(
            (data.agents || []).filter(
              (a: AgentHealth) => a.status !== 'healthy' && a.status !== 'unknown'
            )
          )
        }
      } catch {
        // silent
      }
    }

    poll()
    const interval = setInterval(poll, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  if (unhealthy.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      {unhealthy.map((agent) => {
        const cfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.degraded
        return (
          <div
            key={agent.agent}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border ${cfg.bg} ${cfg.border}`}
          >
            <span className={`w-2 h-2 rounded-full ${cfg.dot} ${cfg.pulse ? 'animate-pulse' : ''}`} />
            <span className={`text-sm font-medium ${cfg.text}`}>
              {getMessage(agent)}
            </span>
            {agent.restart_count_hour > 0 && (
              <span className="text-xs text-zinc-500 ml-auto">
                {agent.restart_count_hour} restart{agent.restart_count_hour > 1 ? 's' : ''}/hr
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
