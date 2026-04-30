'use client'

import { useEffect, useState } from 'react'

interface AgentHeartbeat {
  agent: string
  status: string
  last_heartbeat: string | null
  prompt_count: number
  restart_count_hour: number
  breaker_tripped: boolean
  metadata: Record<string, unknown>
  updated_at: string
}

const STATUS_STYLE: Record<string, { badge: string; dot: string; label: string; accentColor: string }> = {
  healthy:     { badge: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50', dot: 'bg-emerald-400',             label: 'Running',    accentColor: '#34d399' },
  connected:   { badge: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50', dot: 'bg-emerald-400',             label: 'Connected',  accentColor: '#34d399' },
  active:      { badge: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50', dot: 'bg-emerald-400',             label: 'Active',     accentColor: '#34d399' },
  degraded:    { badge: 'bg-amber-900/40 text-amber-300 border-amber-700/40',       dot: 'bg-amber-400 animate-pulse', label: 'Degraded',   accentColor: '#f59e0b' },
  restarting:  { badge: 'bg-blue-900/40 text-blue-300 border-blue-700/40',          dot: 'bg-blue-400 animate-pulse',  label: 'Restarting', accentColor: '#60a5fa' },
  critical:    { badge: 'bg-red-900/50 text-red-300 border-red-700/50',             dot: 'bg-red-400 animate-pulse',   label: 'Critical',   accentColor: '#ef4444' },
  down:        { badge: 'bg-red-900/50 text-red-300 border-red-700/50',             dot: 'bg-red-400 animate-pulse',   label: 'Down',       accentColor: '#ef4444' },
  no_data:     { badge: 'bg-zinc-800/60 text-zinc-600 border-zinc-700/50',          dot: 'bg-zinc-700',                label: 'No data',    accentColor: '#52525b' },
  unknown:     { badge: 'bg-zinc-800/60 text-zinc-500 border-zinc-700/50',          dot: 'bg-zinc-600',                label: 'Unknown',    accentColor: '#71717a' },
}

// Override badge label per-agent when healthy
const AGENT_STATUS_LABEL: Record<string, Partial<Record<string, string>>> = {
  wren:        { healthy: 'Running'   },
  discord_bot: { healthy: 'Connected' },
  task_poller: { healthy: 'Active'    },
  gmail_mcp:   { healthy: 'Active'    },
}

const AGENT_DISPLAY: Record<string, string> = {
  wren:        'Wren (Claude Code)',
  discord_bot: 'Discord bot',
  task_poller: 'Task queue poller',
  gmail_mcp:   'Gmail MCP',
}

// Known interesting agents in display order
const AGENT_ORDER = ['wren', 'discord_bot', 'task_poller', 'gmail_mcp']

function formatAge(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function getStatusStyle(agent: AgentHeartbeat) {
  // Special-case auth_expired from metadata
  const meta = agent.metadata as Record<string, unknown>
  if (meta?.auth_expired || meta?.gmail_auth_expired) {
    return {
      badge: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
      dot: 'bg-amber-400',
      label: 'Auth Expired',
    }
  }
  const base = STATUS_STYLE[agent.status] ?? STATUS_STYLE.no_data
  const override = AGENT_STATUS_LABEL[agent.agent]?.[agent.status]
  return { ...base, label: override ?? base.label }
}

export default function AgentHealthCard() {
  const [agents, setAgents] = useState<AgentHeartbeat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function poll() {
      try {
        const res = await fetch('/api/agent-health')
        const data = await res.json()
        if (mounted) setAgents(data.agents ?? [])
      } catch {}
      if (mounted) setLoading(false)
    }
    poll()
    const iv = setInterval(poll, 30_000)
    return () => { mounted = false; clearInterval(iv) }
  }, [])

  const agentMap = new Map(agents.map((a) => [a.agent, a]))

  // Always show all known agents; synthesize no_data for missing ones
  const extras = agents.filter((a) => !AGENT_ORDER.includes(a.agent))
  const ordered: AgentHeartbeat[] = [
    ...AGENT_ORDER.map((k) => agentMap.get(k) ?? { agent: k, status: 'no_data', last_heartbeat: null, prompt_count: 0, restart_count_hour: 0, breaker_tripped: false, metadata: {}, updated_at: '' }),
    ...extras,
  ]

  // Accent color: red if any critical/down, amber if any degraded/unknown/no_data, green if all healthy
  const worstStatus = ordered.some(a => ['critical', 'down'].includes(a.status)) ? 'red'
    : ordered.some(a => ['degraded', 'unknown', 'no_data'].includes(a.status)) ? 'amber'
    : 'green'
  const accentColor = worstStatus === 'red' ? '#ef4444' : worstStatus === 'amber' ? '#f59e0b' : '#34d399'

  return (
    <div>
      {/* Header accent — color-coded by worst agent status */}
      <div className="w-1 absolute left-0 top-4 bottom-4 rounded-full" style={{ left: '0', marginLeft: '-1px', background: `${accentColor}99` }} />

      <h2 className="text-[10px] font-semibold text-green-400/70 uppercase tracking-widest mb-3">Agent Health</h2>

      {loading ? (
        <div className="flex items-center justify-center h-20">
          <div className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      ) : ordered.length === 0 ? (
        <p className="text-xs text-zinc-600 text-center py-4">No agent data</p>
      ) : (
        <div className="space-y-2">
          {ordered.map((agent) => {
            const style = getStatusStyle(agent)
            const displayName = AGENT_DISPLAY[agent.agent] ?? agent.agent
            return (
              <div key={agent.agent} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
                  <span className="text-xs text-zinc-300 truncate">{displayName}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {agent.restart_count_hour > 0 && (
                    <span className="text-[10px] text-zinc-600">{agent.restart_count_hour}↺/hr</span>
                  )}
                  {agent.last_heartbeat && (
                    <span className="text-[10px] text-zinc-700 hidden sm:block">{formatAge(agent.last_heartbeat)}</span>
                  )}
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wide ${style.badge}`}>
                    {style.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
