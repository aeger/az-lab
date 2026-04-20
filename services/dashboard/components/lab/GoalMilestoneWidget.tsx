'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Goal } from '@/app/api/goals/route'

const STATUS_DOT: Record<string, string> = {
  active:    'bg-blue-400',
  completed: 'bg-green-400',
  planned:   'bg-zinc-500',
  paused:    'bg-yellow-500',
  blocked:   'bg-amber-400',
}

function ProgressBar({ value, status }: { value: number; status: string }) {
  const color = status === 'completed' ? 'bg-green-500' :
                status === 'blocked'   ? 'bg-amber-500' :
                status === 'paused'    ? 'bg-yellow-500' :
                'progress-purple'
  return (
    <div className="h-1 w-full bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${value}%` }} />
    </div>
  )
}

function MilestoneRow({ goal }: { goal: Goal }) {
  const dot = STATUS_DOT[goal.status] ?? 'bg-zinc-600'
  const daysLeft = goal.target_date
    ? Math.ceil((new Date(goal.target_date).getTime() - Date.now()) / 86400000)
    : null

  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-zinc-300 truncate flex-1">{goal.title}</span>
          <span className="text-[10px] text-zinc-600 flex-shrink-0 tabular-nums">{goal.progress}%</span>
        </div>
        <ProgressBar value={goal.progress} status={goal.status} />
      </div>
      {daysLeft !== null && goal.status !== 'completed' && (
        <span className={`text-[10px] flex-shrink-0 tabular-nums ${daysLeft < 0 ? 'text-red-400' : daysLeft < 7 ? 'text-amber-400' : 'text-zinc-600'}`}>
          {daysLeft < 0 ? `${Math.abs(daysLeft)}d over` : `${daysLeft}d`}
        </span>
      )}
    </div>
  )
}

function buildTree(flat: Goal[]): Goal[] {
  const map = new Map<string, Goal>()
  flat.forEach((g) => { g.children = []; map.set(g.id, g) })
  const roots: Goal[] = []
  flat.forEach((g) => {
    if (g.parent_id && map.has(g.parent_id)) map.get(g.parent_id)!.children!.push(g)
    else roots.push(g)
  })
  const sort = (nodes: Goal[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order)
    nodes.forEach((n) => n.children && sort(n.children))
  }
  sort(roots)
  return roots
}

export default function GoalMilestoneWidget() {
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [activeIdx, setActiveIdx] = useState(0)

  useEffect(() => {
    const flatMap = new Map<string, Goal>()
    const es = new EventSource('/api/goals/stream')

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'init') {
        flatMap.clear()
        ;(msg.goals as Goal[]).forEach((g) => flatMap.set(g.id, g))
      } else if (msg.type === 'delta') {
        ;(msg.goals as Goal[]).forEach((g) => flatMap.set(g.id, g))
      }
      setGoals(buildTree(Array.from(flatMap.values())))
      setLoading(false)
    }

    es.onerror = () => { setLoading(false) }

    return () => es.close()
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-16">
      <div className="w-4 h-4 border-2 border-zinc-600 border-t-purple-400 rounded-full animate-spin" />
    </div>
  )

  const visions = goals.filter((g) => g.level === 'vision')
  if (visions.length === 0) return <div className="text-zinc-500 text-xs px-1">No goals defined</div>

  const vision = visions[0]
  const strategies = (vision.children ?? []).filter((c) => c.level === 'strategy' && c.status !== 'completed')
  const active = strategies[activeIdx] ?? strategies[0]
  const milestones = (active?.children ?? []).filter((c) => c.level === 'milestone')
  const done = milestones.filter((m) => m.status === 'completed').length

  return (
    <div className="flex flex-col gap-2">
      {/* Vision */}
      <div className="flex items-start gap-2 px-1">
        <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider flex-shrink-0 mt-0.5">Vision</span>
        <p className="text-xs text-zinc-300 leading-relaxed truncate">{vision.title}</p>
      </div>

      {/* Strategy tabs */}
      <div className="flex items-center gap-0.5 border-b border-zinc-800 overflow-x-auto scrollbar-none">
        {strategies.map((s, i) => {
          const activeMiles = (s.children ?? []).filter((c) => c.level === 'milestone' && c.status === 'active').length
          return (
            <button
              key={s.id}
              onClick={() => setActiveIdx(i)}
              className={`px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap transition-colors -mb-px border-b-2 flex-shrink-0 ${
                i === activeIdx
                  ? 'text-zinc-100 border-purple-400'
                  : 'text-zinc-500 border-transparent hover:text-zinc-300'
              }`}
            >
              {s.title.length > 20 ? s.title.slice(0, 18) + '…' : s.title}
              {activeMiles > 0 && (
                <span className="ml-1 text-[9px] text-blue-400">{activeMiles}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Active strategy header */}
      {active && (
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex-1 min-w-0">
              <ProgressBar value={active.progress} status={active.status} />
            </div>
            <span className="text-[10px] text-zinc-500 tabular-nums flex-shrink-0">{active.progress}%</span>
          </div>
          <span className="text-[10px] text-zinc-600 flex-shrink-0 ml-3">{done}/{milestones.length} done</span>
        </div>
      )}

      {/* Milestone list — fixed height scrollable */}
      <div className="overflow-y-auto divide-y divide-zinc-800/40 px-1 scrollbar-thin scrollbar-thumb-zinc-700" style={{ height: '180px' }}>
        {milestones.length === 0
          ? <div className="text-[10px] text-zinc-600 py-4 text-center">No milestones defined</div>
          : milestones.map((m) => <MilestoneRow key={m.id} goal={m} />)
        }
      </div>

      {/* Footer */}
      <div className="flex justify-end pt-0.5">
        <Link href="/goals" className="text-[10px] text-zinc-500 hover:text-purple-400 transition-colors">
          Big Picture →
        </Link>
      </div>
    </div>
  )
}
