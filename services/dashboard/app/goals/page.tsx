'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import LabSubNav from '@/components/lab/LabSubNav'
import { useKeyboard, getShortcutLabel } from '@/lib/hooks/useKeyboard'
import type { Goal } from '@/app/api/goals/route'

// ── tree builder ───────────────────────────────────────────────────────────────

function buildTree(flat: Goal[]): Goal[] {
  const map = new Map<string, Goal>()
  flat.forEach((g) => { map.set(g.id, { ...g, children: [] }) })
  const roots: Goal[] = []
  flat.forEach((g) => {
    const node = map.get(g.id)!
    if (g.parent_id && map.has(g.parent_id)) map.get(g.parent_id)!.children!.push(node)
    else roots.push(node)
  })
  const sort = (nodes: Goal[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order)
    nodes.forEach((n) => n.children && sort(n.children))
  }
  sort(roots)
  return roots
}

// ── sort type ──────────────────────────────────────────────────────────────────

type SortBy = 'priority' | 'date' | 'progress' | 'title'

function sortGoals(gs: Goal[], by: SortBy): Goal[] {
  return [...gs].sort((a, b) => {
    switch (by) {
      case 'date':
        if (a.target_date && b.target_date) return a.target_date.localeCompare(b.target_date)
        if (a.target_date) return -1
        if (b.target_date) return 1
        return a.sort_order - b.sort_order
      case 'progress':
        return b.progress - a.progress
      case 'title':
        return a.title.localeCompare(b.title)
      case 'priority':
      default:
        if (a.priority !== b.priority) return a.priority - b.priority
        return a.sort_order - b.sort_order
    }
  })
}

// ── search helper ──────────────────────────────────────────────────────────────

function nodeMatchesSearch(goal: Goal, text: string): boolean {
  if (!text) return true
  const q = text.toLowerCase()
  const selfMatches =
    goal.title.toLowerCase().includes(q) ||
    (goal.description ?? '').toLowerCase().includes(q) ||
    (goal.tags ?? []).some((t) => t.toLowerCase().includes(q))
  const childMatches = (goal.children ?? []).some((c) => nodeMatchesSearch(c, text))
  return selfMatches || childMatches
}

// ── filter bar ─────────────────────────────────────────────────────────────────

const ALL_STATUSES = ['active', 'planned', 'paused', 'blocked', 'completed', 'archived'] as const
const ALL_LEVELS   = ['vision', 'strategy', 'milestone', 'objective'] as const

const LEVEL_DISPLAY: Record<string, string> = {
  vision:    'Vision',
  strategy:  'Goal',
  milestone: 'Milestone',
  objective: 'Task',
}

const STATUS_PILL: Record<string, { on: string; border: string; dim: string }> = {
  active:    { on: '#60a5fa', border: 'rgba(96,165,250,0.4)',   dim: 'rgba(96,165,250,0.07)'   },
  planned:   { on: '#a1a1aa', border: 'rgba(161,161,170,0.35)', dim: 'rgba(161,161,170,0.07)'  },
  paused:    { on: '#fbbf24', border: 'rgba(251,191,36,0.4)',   dim: 'rgba(251,191,36,0.07)'   },
  blocked:   { on: '#fb923c', border: 'rgba(251,146,60,0.4)',   dim: 'rgba(251,146,60,0.07)'   },
  completed: { on: '#4ade80', border: 'rgba(74,222,128,0.4)',   dim: 'rgba(74,222,128,0.07)'   },
  archived:  { on: '#52525b', border: 'rgba(82,82,91,0.4)',     dim: 'rgba(82,82,91,0.07)'     },
}
const LEVEL_PILL: Record<string, { on: string; border: string; dim: string }> = {
  vision:    { on: '#c084fc', border: 'rgba(192,132,252,0.4)',  dim: 'rgba(192,132,252,0.07)'  },
  strategy:  { on: '#818cf8', border: 'rgba(129,140,248,0.4)',  dim: 'rgba(129,140,248,0.07)'  },
  milestone: { on: '#94a3b8', border: 'rgba(148,163,184,0.4)',  dim: 'rgba(148,163,184,0.07)'  },
  objective: { on: '#71717a', border: 'rgba(113,113,122,0.4)',  dim: 'rgba(113,113,122,0.07)'  },
}

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'date',     label: 'Date' },
  { value: 'progress', label: 'Progress' },
  { value: 'title',    label: 'Title' },
]

interface FilterBarProps {
  filterStatuses: Set<string>
  filterLevels: Set<string>
  onToggleStatus: (s: string) => void
  onToggleLevel: (l: string) => void
  onReset: () => void
  sortBy: SortBy
  onSortChange: (v: SortBy) => void
  searchText: string
  onSearchChange: (v: string) => void
}

function FilterBar({ filterStatuses, filterLevels, onToggleStatus, onToggleLevel, onReset, sortBy, onSortChange, searchText, onSearchChange }: FilterBarProps) {
  const isFiltered =
    filterStatuses.size < ALL_STATUSES.length ||
    filterLevels.size < ALL_LEVELS.length ||
    searchText.length > 0

  return (
    <div className="mb-5 px-3 py-3 bg-zinc-900/30 border border-zinc-800/50 rounded-xl space-y-2.5">
      {/* Row 1: Status + Level filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mr-1">Status</span>
        {ALL_STATUSES.map((s) => {
          const on = filterStatuses.has(s)
          const c = STATUS_PILL[s]
          return (
            <button
              key={s}
              onClick={() => onToggleStatus(s)}
              style={{
                background: on ? `${c.dim}` : 'transparent',
                border: `1px solid ${on ? c.border : 'rgba(63,63,70,0.5)'}`,
                color: on ? c.on : '#52525b',
              }}
              className="text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase tracking-wide transition-all duration-150 hover:scale-105"
            >
              {s}
            </button>
          )
        })}
        <span className="text-zinc-700 text-xs mx-1">|</span>
        <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mr-1">Level</span>
        {ALL_LEVELS.map((l) => {
          const on = filterLevels.has(l)
          const c = LEVEL_PILL[l]
          return (
            <button
              key={l}
              onClick={() => onToggleLevel(l)}
              style={{
                background: on ? `${c.dim}` : 'transparent',
                border: `1px solid ${on ? c.border : 'rgba(63,63,70,0.5)'}`,
                color: on ? c.on : '#52525b',
              }}
              className="text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase tracking-wide transition-all duration-150 hover:scale-105"
            >
              {LEVEL_DISPLAY[l] ?? l}
            </button>
          )
        })}
        {isFiltered && (
          <button
            onClick={onReset}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-auto transition-colors underline underline-offset-2"
          >
            Reset
          </button>
        )}
      </div>

      {/* Row 2: Sort + Search */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mr-1">Sort</span>
        {SORT_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onSortChange(value)}
            style={sortBy === value ? {
              background: 'rgba(167,139,250,0.1)',
              border: '1px solid rgba(167,139,250,0.4)',
              color: '#c084fc',
            } : {
              background: 'transparent',
              border: '1px solid rgba(63,63,70,0.5)',
              color: '#52525b',
            }}
            className="text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase tracking-wide transition-all duration-150 hover:scale-105"
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-zinc-600 text-xs">🔍</span>
          <input
            type="text"
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search goals…"
            className="text-[11px] bg-zinc-900/60 border border-zinc-700/60 rounded-full px-2.5 py-1 text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-purple-600/60 w-40"
          />
          {searchText && (
            <button onClick={() => onSearchChange('')} className="text-zinc-600 hover:text-zinc-300 text-xs transition-colors">✕</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── filter + search helper ─────────────────────────────────────────────────────

function nodeMatchesFilter(goal: Goal, statuses: Set<string>, levels: Set<string>, search: string): boolean {
  const selfMatches = statuses.has(goal.status) && levels.has(goal.level) && nodeMatchesSearch(goal, search)
  const childMatches = (goal.children ?? []).some((c) => nodeMatchesFilter(c, statuses, levels, search))
  return selfMatches || childMatches
}

// ── status / level styling ─────────────────────────────────────────────────────

const STATUS_BG: Record<string, string> = {
  active:    'bg-blue-900/50 text-blue-300 border-blue-800/50',
  completed: 'bg-green-900/50 text-green-300 border-green-800/50',
  planned:   'bg-zinc-800/60 text-zinc-400 border-zinc-700/50',
  paused:    'bg-yellow-900/30 text-yellow-400 border-yellow-800/30',
  blocked:   'bg-amber-900/40 text-amber-300 border-amber-800/40',
}

const LEVEL_BADGE: Record<string, string> = {
  vision:    'bg-purple-900/50 text-purple-300',
  strategy:  'bg-indigo-900/50 text-indigo-300',
  milestone: 'bg-zinc-800 text-zinc-300',
  objective: 'bg-zinc-800/50 text-zinc-500',
}



const STATUS_ICON: Record<string, string> = {
  active:    '● ',
  completed: '✓ ',
  paused:    '⏸ ',
  blocked:   '⚠ ',
  planned:   '○ ',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border uppercase tracking-wide ${STATUS_BG[status] ?? STATUS_BG.planned}`}>
      {STATUS_ICON[status] ?? ''}{status}
    </span>
  )
}

function LevelBadge({ level }: { level: string }) {
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded uppercase tracking-wide ${LEVEL_BADGE[level] ?? LEVEL_BADGE.milestone}`}>
      {LEVEL_DISPLAY[level] ?? level}
    </span>
  )
}

const RUNNING_TASK_STATUSES = new Set(['in_progress_agent', 'claimed', 'in_progress_jeff'])

function computeChildProgress(goal: Goal): number {
  const objectives = (goal.children ?? []).filter(c => c.level === 'objective')
  if (!objectives.length) return goal.progress
  const sum = objectives.reduce((acc, c) => acc + (c.status === 'completed' ? 100 : c.progress), 0)
  return Math.round(sum / objectives.length)
}

function calculateAggregateProgress(goal: Goal): number {
  if (!goal.children || goal.children.length === 0) return goal.progress
  const childProgress = goal.children.map(c => calculateAggregateProgress(c))
  return Math.round(childProgress.reduce((sum, p) => sum + p, 0) / childProgress.length)
}

function TitleProgressBar({ goal }: { goal: Goal }) {
  const isVisionOrStrategy = goal.level === 'vision' || goal.level === 'strategy'
  const displayProgress = isVisionOrStrategy ? calculateAggregateProgress(goal) : goal.progress
  const color = goal.status === 'completed' ? 'bg-green-400' : 'bg-amber-400'

  return (
    <div className="h-0.5 bg-zinc-800/50 rounded-full overflow-hidden mt-1.5 mb-2">
      <div
        className={`h-full rounded-full ${color} transition-all duration-300 opacity-60`}
        style={{ width: `${displayProgress}%` }}
      />
    </div>
  )
}

function ProgressBar({ value, status, taskStatus }: { value: number; status: string; taskStatus?: TaskStatus }) {
  const isRunning = taskStatus ? RUNNING_TASK_STATUSES.has(taskStatus.status) : false
  const color = isRunning          ? 'bg-blue-500' :
                status === 'completed' ? 'bg-green-500' :
                status === 'blocked'   ? 'bg-amber-500' :
                status === 'paused'    ? 'bg-yellow-500' : 'progress-purple'
  const fillStyle: React.CSSProperties = {
    width: `${Math.max(value, isRunning ? 3 : 0)}%`,
    ...(isRunning ? { boxShadow: '0 0 8px rgba(59,130,246,0.6)', animation: 'pulse 2s infinite' } :
        status === 'active' ? { boxShadow: '0 0 6px rgba(167,139,250,0.4)' } : {}),
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={fillStyle} />
      </div>
      {isRunning ? (
        <span className="text-[10px] text-blue-400 tabular-nums whitespace-nowrap">In Progress</span>
      ) : (
        <span className="text-[10px] text-zinc-500 tabular-nums w-7 text-right">{value}%</span>
      )}
    </div>
  )
}

// ── schedule form (inline) ─────────────────────────────────────────────────────

interface ScheduleFormProps {
  goal: Goal
  onClose: () => void
}

function GoalEditForm({ goal, flat = [], onClose, onSaved }: { goal: Goal; flat?: Goal[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    title: goal.title,
    description: goal.description ?? '',
    notes: goal.notes ?? '',
    level: goal.level,
    parent_id: goal.parent_id ?? '',
    priority: goal.priority,
    target_date: goal.target_date ?? '',
    tags: (goal.tags ?? []).join(', '),
    progress: goal.progress,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewAgent, setReviewAgent] = useState<string>('')

  // Derived parent options based on level
  const visions    = flat.filter(g => g.level === 'vision'    && g.status !== 'archived' && g.id !== goal.id)
  const strategies = flat.filter(g => g.level === 'strategy'  && g.status !== 'archived' && g.id !== goal.id)
  const milestones = flat.filter(g => g.level === 'milestone' && g.status !== 'archived' && g.id !== goal.id)

  // For task parent: group milestones by their parent goal
  const milestonesByGoal = strategies.map(s => ({
    goal: s,
    milestones: milestones.filter(m => m.parent_id === s.id),
  })).filter(g => g.milestones.length > 0)
  const orphanMilestones = milestones.filter(m => !strategies.find(s => s.id === m.parent_id))

  const parentRequired = form.level === 'milestone' || form.level === 'objective'
  const canSave = form.title.trim() && (!parentRequired || form.parent_id)

  function handleLevelChange(level: Goal['level']) {
    setForm(f => ({ ...f, level, parent_id: '' }))
  }

  async function handleSave() {
    if (!canSave) { setError(parentRequired ? 'Parent is required for this type' : 'Title is required'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/goals/${goal.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
          target_date: form.target_date || null,
          description: form.description || null,
          notes: form.notes || null,
          parent_id: form.parent_id || null,
          reviewAgent: reviewAgent || null,
          // Lock progress if user explicitly changed it from the original value
          ...(form.progress !== goal.progress ? { progress_locked: true } : {}),
        }),
      })
      if (res.ok) onSaved()
      else { const d = await res.json(); setError(d.error ?? 'Save failed') }
    } catch { setError('Save failed') } finally { setSaving(false) }
  }

  const inputCls = 'w-full bg-zinc-900/60 border border-zinc-700/50 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500'
  const labelCls = 'text-[10px] text-zinc-500 uppercase tracking-wider block mb-1'

  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-800/60 border border-zinc-700/50 space-y-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-zinc-300">Edit {LEVEL_DISPLAY[form.level] ?? form.level}</span>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 text-sm">✕</button>
      </div>

      {/* Level selector */}
      <div className="grid grid-cols-4 gap-1">
        {(['vision', 'strategy', 'milestone', 'objective'] as Goal['level'][]).map(lv => (
          <button
            key={lv}
            type="button"
            onClick={() => handleLevelChange(lv)}
            className={`py-1 rounded text-[10px] font-semibold border transition-colors ${
              form.level === lv
                ? 'bg-purple-900/50 border-purple-700/60 text-purple-300'
                : 'bg-zinc-900/40 border-zinc-700/40 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
            }`}
          >
            {LEVEL_DISPLAY[lv]}
          </button>
        ))}
      </div>

      {/* Parent selector — changes based on level */}
      {form.level === 'strategy' && visions.length > 0 && (
        <div>
          <label className={labelCls}>Vision (optional)</label>
          <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className={inputCls}>
            <option value="">No parent vision</option>
            {visions.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
        </div>
      )}
      {form.level === 'milestone' && (
        <div>
          <label className={labelCls}>Goal *</label>
          <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className={inputCls} required>
            <option value="" disabled>Select a Goal…</option>
            {strategies.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
      )}
      {form.level === 'objective' && (
        <div>
          <label className={labelCls}>Milestone *</label>
          <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className={inputCls} required>
            <option value="" disabled>Select a Milestone…</option>
            {milestonesByGoal.map(({ goal: g, milestones: ms }) => (
              <optgroup key={g.id} label={g.title}>
                {ms.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
              </optgroup>
            ))}
            {orphanMilestones.length > 0 && (
              <optgroup label="— Other Milestones —">
                {orphanMilestones.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      )}

      <div>
        <label className={labelCls}>Title</label>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
                  className="w-full bg-zinc-900/60 border border-zinc-700/50 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 resize-none" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={labelCls}>Priority</label>
          <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: +e.target.value }))}
                  className={inputCls}>
            <option value={0}>0 — Critical</option>
            <option value={1}>1 — High</option>
            <option value={2}>2 — Normal</option>
            <option value={3}>3 — Low</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>
            Progress %
            {goal.progress_locked && <span className="ml-1 text-amber-500 normal-case">🔒 locked</span>}
          </label>
          <div className="flex gap-1">
            <input type="number" min={0} max={100} value={form.progress} onChange={e => setForm(f => ({ ...f, progress: +e.target.value }))}
                   className={inputCls} />
            {goal.progress_locked && (
              <button type="button"
                onClick={async () => {
                  await fetch(`/api/goals/${goal.id}/edit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ progress_locked: false }),
                  })
                  onSaved()
                }}
                className="px-2 py-1 text-[10px] rounded border border-zinc-600 bg-zinc-800 text-zinc-400 hover:text-amber-300 hover:border-amber-600/50 whitespace-nowrap transition-colors"
                title="Unlock — let task completion drive progress automatically"
              >
                Unlock
              </button>
            )}
          </div>
        </div>
        <div>
          <label className={labelCls}>Target Date</label>
          <input type="date" value={form.target_date} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))}
                 className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Tags (comma-separated)</label>
        <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} className={inputCls} />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 pt-1 items-center">
        <select value={reviewAgent} onChange={e => setReviewAgent(e.target.value)}
                className="bg-zinc-900/60 border border-zinc-700/50 rounded px-2 py-1.5 text-xs text-zinc-400 focus:outline-none">
          <option value="">No review</option>
          <option value="claude-code">Wren (Claude Code)</option>
          <option value="iris">Iris (Cowork)</option>
          <option value="atlas">Atlas (Desktop)</option>
          <option value="forge">Forge</option>
        </select>
        <button onClick={handleSave} disabled={saving || !canSave}
                className="flex-1 py-1.5 rounded text-xs bg-sky-900/60 text-sky-300 hover:bg-sky-800/80 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onClose} className="px-3 py-1.5 rounded text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300">Cancel</button>
      </div>
    </div>
  )
}

function ScheduleForm({ goal, onClose }: ScheduleFormProps) {
  const today = new Date().toISOString().slice(0, 10)
  const nowTime = new Date().toTimeString().slice(0, 5)
  const [date, setDate] = useState(goal.target_date ?? today)
  const [time, setTime] = useState(nowTime)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSchedule() {
    setLoading(true)
    setError(null)
    try {
      const startDt = new Date(`${date}T${time}:00`)
      const endDt = new Date(startDt.getTime() + 60 * 60 * 1000)

      // Write to almty1@gmail.com — service account needs edit access on that calendar
      const res = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId: 'almty1@gmail.com',
          title: goal.title,
          description: goal.description ?? `Goal: ${goal.title}`,
          start: startDt.toISOString(),
          end: endDt.toISOString(),
          allDay: false,
        }),
      })
      if (res.ok) {
        // Persist target_date in the goal so it survives a page refresh
        await fetch('/api/goals', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: goal.id, target_date: date, status: 'planned' }),
        }).catch(() => {/* non-fatal */})
        setResult(`Scheduled for ${startDt.toLocaleDateString()} at ${startDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
      } else {
        const data = await res.json()
        setError(data.error ?? 'Failed to create event')
      }
    } catch {
      setError('Request failed')
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    return (
      <div className="mt-3 p-3 rounded-lg bg-green-900/20 border border-green-800/40">
        <p className="text-xs text-green-400">Scheduled: {result}</p>
        <button onClick={onClose} className="mt-2 text-[10px] text-zinc-500 hover:text-zinc-300">Dismiss</button>
      </div>
    )
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-800/40 border border-zinc-700/50">
      <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Schedule as Calendar Event</p>
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="text-[10px] text-zinc-500 block mb-0.5">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-purple-600"
          />
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 block mb-0.5">Time</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-purple-600"
          />
        </div>
        <button
          onClick={handleSchedule}
          disabled={loading}
          className="text-xs px-2.5 py-1 rounded-md border border-purple-800/60 bg-purple-900/30 text-purple-300 hover:bg-purple-900/50 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Creating…' : 'Create Event'}
        </button>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded-md border border-zinc-700/50 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}

// ── notes helpers ───────────────────────────────────────────────────────────────

function parseNotes(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {}
  return [raw]
}

function serializeNotes(items: string[]): string | null {
  const filtered = items.filter(s => s.trim())
  return filtered.length ? JSON.stringify(filtered) : null
}

// ── notes popover (notebook icon + hover tooltip) ──────────────────────────────

function NotesPopover({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false)
  const items = parseNotes(notes)
  const preview = items.map((n, i) => `${i + 1}. ${n.replace(/[#*`_~\[\]]/g, '').slice(0, 120)}`).join('\n')
  return (
    <div className="relative inline-flex items-center">
      <button
        className="text-[13px] leading-none text-zinc-500 hover:text-amber-400 transition-colors"
        title="Has notes"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => e.stopPropagation()}
      >
        📓
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 z-50 w-72 max-h-48 overflow-y-auto bg-zinc-800 border border-zinc-700 rounded-lg p-2.5 text-[10px] text-zinc-300 shadow-2xl whitespace-pre-wrap"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {preview}
        </div>
      )}
    </div>
  )
}

// ── read-only numbered notes display ────────────────────────────────────────────

function NotesDisplay({ notes }: { notes: string }) {
  const items = parseNotes(notes)
  if (!items.length) return null
  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex gap-1.5 text-xs text-zinc-400">
          <span className="text-[10px] font-mono text-zinc-600 flex-shrink-0 mt-0.5 w-4 text-right">{i + 1}.</span>
          <span className="leading-relaxed break-words">{item}</span>
        </div>
      ))}
    </div>
  )
}

// ── individual numbered notes editor ────────────────────────────────────────────

function NotesList({ goal, onSaved }: { goal: Goal; onSaved: () => void }) {
  const [items, setItems] = useState<string[]>(() => parseNotes(goal.notes))
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function persist(nextItems: string[]) {
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/goals/${goal.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: serializeNotes(nextItems) }),
      })
      if (res.ok) { setItems(nextItems); onSaved() }
      else { const d = await res.json(); setError(d.error ?? 'Save failed') }
    } catch { setError('Save failed') } finally { setSaving(false) }
  }

  function startEdit(idx: number) { setEditIdx(idx); setEditText(items[idx]) }

  function saveEdit() {
    if (editIdx === null) return
    const trimmed = editText.trim()
    if (!trimmed) { deleteItem(editIdx); return }
    const next = [...items]; next[editIdx] = trimmed
    setEditIdx(null); persist(next)
  }

  function deleteItem(idx: number) {
    setEditIdx(null)
    persist(items.filter((_, i) => i !== idx))
  }

  function addNote() {
    const next = [...items, '']
    setItems(next); setEditIdx(next.length - 1); setEditText('')
  }

  return (
    <div className="mt-2 p-2.5 rounded-lg bg-zinc-900/50 border border-zinc-700/40 space-y-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Notes</span>
        <button onClick={addNote} disabled={saving}
          className="text-[10px] px-2 py-0.5 rounded border border-zinc-600/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-40">
          + Add note
        </button>
      </div>
      {items.length === 0 && (
        <p className="text-[10px] text-zinc-600 italic">No notes yet — click + Add note</p>
      )}
      {items.map((item, idx) => (
        <div key={idx} className="flex gap-2 items-start group/note">
          <span className="text-[10px] font-mono text-zinc-600 mt-0.5 flex-shrink-0 w-4 text-right">{idx + 1}.</span>
          {editIdx === idx ? (
            <div className="flex-1 space-y-1">
              <textarea
                autoFocus
                value={editText}
                onChange={e => setEditText(e.target.value)}
                rows={3}
                className="w-full bg-zinc-900/60 border border-zinc-600/50 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500 resize-y font-mono placeholder:text-zinc-600"
                placeholder="Note text…"
                onKeyDown={e => { if (e.key === 'Escape') setEditIdx(null) }}
              />
              <div className="flex gap-1">
                <button onClick={saveEdit} disabled={saving}
                  className="text-[10px] px-2 py-0.5 rounded bg-sky-900/60 text-sky-300 hover:bg-sky-800/80 disabled:opacity-40">
                  {saving ? '…' : 'Save'}
                </button>
                <button onClick={() => setEditIdx(null)}
                  className="text-[10px] px-2 py-0.5 rounded border border-zinc-700/50 text-zinc-500 hover:text-zinc-300">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-start gap-1">
              <span className="flex-1 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">{item}</span>
              <div className="flex gap-0.5 opacity-0 group-hover/note:opacity-100 transition-opacity flex-shrink-0">
                <button onClick={() => startEdit(idx)}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700/50 bg-zinc-800/50 text-zinc-500 hover:text-zinc-200">✎</button>
                <button onClick={() => deleteItem(idx)} disabled={saving}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-red-900/50 text-red-600 hover:text-red-400 disabled:opacity-40">✕</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}

// ── goal card ──────────────────────────────────────────────────────────────────

interface TaskCounts {
  active: number
  done: number
  blocked: number
  partial: number
  total: number
  pct_complete: number
}

interface TaskStatus {
  id: string
  status: string
  updated_at: string
  claimed_by: string | null
  error: string | null
  counts?: TaskCounts
}

interface GoalCardProps {
  goal: Goal
  flat?: Goal[]
  depth?: number
  onTrigger: (goal: Goal) => Promise<string>
  onFlag: (taskId: string) => Promise<void>
  triggeredTaskId?: string
  taskStatus?: TaskStatus
  allTaskStatuses?: Record<string, TaskStatus>
  filterStatuses?: Set<string>
  filterLevels?: Set<string>
  searchText?: string
}

function TaskStatusBadge({ ts }: { ts: TaskStatus }) {
  const cfg: Record<string, { cls: string; label: string }> = {
    pending:   { cls: 'bg-zinc-800 text-zinc-400 border-zinc-700', label: 'Queued' },
    claimed:   { cls: 'bg-blue-900/50 text-blue-300 border-blue-800/50', label: 'Running' },
    completed: { cls: 'bg-green-900/50 text-green-300 border-green-800/50', label: 'Done' },
    failed:    { cls: 'bg-red-900/40 text-red-300 border-red-800/40', label: 'Failed' },
    blocked:   { cls: 'bg-amber-900/40 text-amber-300 border-amber-800/40', label: 'Blocked' },
  }
  const { cls, label } = cfg[ts.status] ?? cfg.pending
  return (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${cls}`} title={ts.error ?? ts.claimed_by ?? ts.id}>
      {label}
    </span>
  )
}

function GoalCard({ goal, flat = [], depth = 0, onTrigger, onFlag, triggeredTaskId, taskStatus, allTaskStatuses, filterStatuses, filterLevels, searchText = '', onArchive, onRestore, onRefresh }: GoalCardProps & { onArchive?: (id: string) => void; onRestore?: (id: string) => void; onRefresh?: () => void }) {
  const daysLeft = goal.target_date
    ? Math.ceil((new Date(goal.target_date).getTime() - Date.now()) / 86400000)
    : null
  const hasChildren = (goal.children?.length ?? 0) > 0
  const [collapsed, setCollapsed] = useState(false)
  const [cardExpanded, setCardExpanded] = useState(goal.level === 'vision' || goal.level === 'strategy')
  const [showNotes, setShowNotes] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [flagging, setFlagging] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null)

  async function handleTrigger() {
    setTriggering(true)
    setTriggerMsg(null)
    try {
      const taskId = await onTrigger(goal)
      setTriggerMsg(`Queued (task ${taskId.slice(0, 8)}…)`)
    } catch {
      setTriggerMsg('Failed to queue')
    } finally {
      setTriggering(false)
    }
  }

  async function handleFlag() {
    if (!triggeredTaskId) return
    setFlagging(true)
    try {
      await onFlag(triggeredTaskId)
      setTriggerMsg('Flagged for review')
    } catch {
      setTriggerMsg('Flag failed')
    } finally {
      setFlagging(false)
    }
  }

  async function handleArchive() {
    setArchiving(true)
    try {
      await fetch(`/api/goals/${goal.id}/archive`, { method: 'POST' })
      onArchive?.(goal.id)
    } catch { /* noop */ } finally { setArchiving(false) }
  }

  async function handleRestore() {
    setArchiving(true)
    try {
      await fetch(`/api/goals/${goal.id}/restore`, { method: 'POST' })
      onRestore?.(goal.id)
    } catch { /* noop */ } finally { setArchiving(false) }
  }

  async function handleStatusChange(status: string) {
    setActionBusy(status)
    setActionError(null)
    try {
      const res = await fetch(`/api/goals/${goal.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (res.ok) onRefresh?.()
      else setActionError('Failed')
    } catch { setActionError('Failed') } finally { setActionBusy(null) }
  }

  async function handleDelete() {
    setActionBusy('delete')
    setActionError(null)
    try {
      const res = await fetch(`/api/goals/${goal.id}/delete`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) { onRefresh?.(); setShowDeleteConfirm(false) }
      else setActionError(data.error ?? 'Delete failed')
    } catch { setActionError('Delete failed') } finally { setActionBusy(null) }
  }

  const LEVEL_STRIPE: Record<string, string> = {
    vision:    'border-l-4 border-l-purple-500 bg-purple-950/10',
    strategy:  'border-l-4 border-l-indigo-500',
    milestone: 'border-l-4 border-l-blue-700/60',
    objective: 'border-l-4 border-l-zinc-700',
  }
  const levelStripe = LEVEL_STRIPE[goal.level] ?? LEVEL_STRIPE.milestone
  const statusMod = goal.status === 'blocked' ? 'ring-1 ring-amber-800/40' :
                    goal.status === 'completed' ? 'opacity-70' : ''
  const noteCount = parseNotes(goal.notes).length

  const visibleChildren = (goal.children ?? []).filter((child) =>
    !filterStatuses || !filterLevels
      ? true
      : nodeMatchesFilter(child, filterStatuses, filterLevels, searchText)
  )

  return (
    <div className={`${depth > 0 ? 'ml-4 border-l border-zinc-800/60 pl-4' : ''}`}>
      <div data-goal-id={goal.id} className={`card-lift rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4 mb-3 ${levelStripe} ${statusMod}`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <LevelBadge level={goal.level} />
            <StatusBadge status={goal.status} />
            {goal.target_date && goal.status !== 'completed' && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-sky-900/40 text-sky-300 border border-sky-800/40 uppercase tracking-wide" title={`Scheduled: ${goal.target_date}`}>Scheduled</span>
            )}
            {goal.priority === 0 && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-red-900/50 text-red-300 uppercase tracking-wide">Critical</span>
            )}
            {goal.priority === 1 && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-orange-900/40 text-orange-300 uppercase tracking-wide">High</span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 text-right">
            {daysLeft !== null && goal.status !== 'completed' && (
              <span className={`text-xs font-semibold tabular-nums ${
                daysLeft < 0
                  ? 'text-red-400 bg-red-950/30 px-1.5 py-0.5 rounded'
                  : daysLeft < 7
                  ? 'text-amber-400 bg-amber-950/30 px-1.5 py-0.5 rounded'
                  : 'text-zinc-500'
              }`}>
                {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
              </span>
            )}
            {goal.target_date && (
              <span className="text-[10px] text-zinc-600">{goal.target_date}</span>
            )}
            {hasChildren && (
              <button
                data-action="toggle-details"
                onClick={() => setCollapsed((v) => !v)}
                className="text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors px-1.5 py-0.5 rounded border border-zinc-800/60 hover:border-zinc-600 bg-zinc-900/50 flex items-center gap-1"
                title={collapsed ? 'Expand children' : 'Collapse children'}
              >
                <span>{collapsed ? '▶' : '▼'}</span>
                <span>{goal.children!.length}</span>
              </button>
            )}
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-2 mb-1 cursor-pointer group"
          onClick={() => setCardExpanded(v => !v)}
        >
          <h3
            className={`font-semibold flex-1 group-hover:text-white transition-colors ${
              goal.level === 'vision' ? 'text-xl font-bold text-white' :
              goal.level === 'strategy' ? 'text-base text-zinc-100' :
              'text-sm text-zinc-200'
            }`}
            style={goal.level === 'vision' ? { textShadow: '0 0 20px rgba(167,139,250,0.3)' } : undefined}
          >{goal.title}</h3>

          <TitleProgressBar goal={goal} />

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {!cardExpanded && goal.notes && <NotesPopover notes={goal.notes} />}
            <span className="text-[10px] text-zinc-600 group-hover:text-zinc-400 transition-colors">{cardExpanded ? '▲' : '▼'}</span>
          </div>
        </div>

        <TitleProgressBar goal={goal} />

        {goal.description && (
          <div className="mb-3 max-h-40 overflow-y-auto pr-1">
            <MarkdownPreview content={goal.description} />
          </div>
        )}

        <ProgressBar
          value={
            taskStatus?.counts && taskStatus.counts.total > 0 && !goal.progress_locked
              ? taskStatus.counts.pct_complete
              : goal.level === 'milestone' ? computeChildProgress(goal) : goal.progress
          }
          status={goal.status}
          taskStatus={taskStatus}
        />

        {taskStatus?.counts && taskStatus.counts.total > 0 && (
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <button
              onClick={(e) => { e.stopPropagation(); setShowNotes(v => !v); if (!cardExpanded) setCardExpanded(true) }}
              className={`text-[11px] px-1.5 py-0.5 rounded transition-colors flex-shrink-0 flex items-center gap-0.5 ${showNotes ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-400'}`}
              title={noteCount > 0 ? `${noteCount} note${noteCount > 1 ? 's' : ''}` : 'Notes'}
            >📓{noteCount > 0 && <span className="text-[9px] font-bold leading-none px-1 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 min-w-[14px] text-center">{noteCount}</span>}</button>
            <span className="text-[9px] font-semibold text-zinc-600 uppercase tracking-wider">tasks</span>
            {taskStatus.counts.done > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/25 text-green-400 border border-green-800/30">
                ✓ {taskStatus.counts.done}
              </span>
            )}
            {taskStatus.counts.active > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/25 text-blue-400 border border-blue-800/30">
                ● {taskStatus.counts.active}
              </span>
            )}
            {(taskStatus.counts.partial ?? 0) > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-900/25 text-sky-400 border border-sky-800/30">
                ½ {taskStatus.counts.partial}
              </span>
            )}
            {taskStatus.counts.blocked > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/25 text-amber-400 border border-amber-800/30">
                ⚠ {taskStatus.counts.blocked}
              </span>
            )}
            <span className="text-[9px] text-zinc-600 ml-0.5">
              {taskStatus.counts.pct_complete}% done
            </span>
          </div>
        )}

        {/* Notebook icon when no tasks exist — still show on its own line */}
        {!(taskStatus?.counts && taskStatus.counts.total > 0) && (
          <div className="flex items-center mt-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); setShowNotes(v => !v); if (!cardExpanded) setCardExpanded(true) }}
              className={`text-[11px] px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${showNotes ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-400'}`}
              title={noteCount > 0 ? `${noteCount} note${noteCount > 1 ? 's' : ''}` : 'Notes'}
            >📓{noteCount > 0 && <span className="text-[9px] font-bold leading-none px-1 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 min-w-[14px] text-center">{noteCount}</span>}</button>
          </div>
        )}

        {cardExpanded && goal.tags && goal.tags.length > 0 && (
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {goal.tags.map((t) => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-500">{t}</span>
            ))}
          </div>
        )}

        {showNotes && (
          <>
            {showNotes ? (
              <NotesList goal={goal} onSaved={() => { onRefresh?.() }} />
            ) : goal.notes ? (
              <div className="mt-2 group/notes relative border-l-2 border-zinc-700/60 pl-2 max-h-28 overflow-y-auto">
                <NotesDisplay notes={goal.notes} />
                <button
                  onClick={(e) => { e.stopPropagation(); setShowNotes(true) }}
                  className="absolute top-0 right-0 hidden group-hover/notes:inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/90 border border-zinc-700/60 text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  ✎ Edit
                </button>
              </div>
            ) : null}
          </>
        )}

        {/* Action buttons */}
        {cardExpanded && (
        <div className="mt-3 pt-3 border-t border-zinc-800/40 flex items-center gap-2 flex-wrap">
          <button
            onClick={handleTrigger}
            disabled={triggering}
            className="text-xs px-2.5 py-1 rounded-md border border-zinc-600 bg-zinc-800/50 text-zinc-300 hover:text-white hover:border-purple-500/50 hover:bg-purple-900/20 disabled:opacity-50 transition-colors"
          >
            {triggering ? '…' : '▶ Run'}
          </button>
          <button
            onClick={() => setShowSchedule((v) => !v)}
            className="text-xs px-2.5 py-1 rounded-md border border-zinc-600 bg-zinc-800/50 text-zinc-300 hover:text-white hover:border-purple-500/50 hover:bg-purple-900/20 transition-colors"
          >
            Schedule
          </button>
          {triggeredTaskId && (
            <button
              onClick={handleFlag}
              disabled={flagging}
              className="text-xs px-2.5 py-1 rounded-md border border-amber-800/60 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 disabled:opacity-50 transition-colors"
            >
              {flagging ? '…' : 'Flag'}
            </button>
          )}
          {taskStatus ? (
            <TaskStatusBadge ts={taskStatus} />
          ) : triggerMsg ? (
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ml-1 ${
              triggerMsg.startsWith('Queued') ? 'bg-green-900/50 text-green-300 border-green-800/50' :
              triggerMsg.startsWith('Flagged') ? 'bg-amber-900/40 text-amber-300 border-amber-800/40' :
              'bg-red-900/40 text-red-300 border-red-800/40'
            }`}>{triggerMsg}</span>
          ) : null}

          {/* Goal actions */}
          <div className="ml-auto flex items-center gap-1 flex-wrap justify-end">
            {actionError && <span className="text-[10px] text-red-400 mr-1">{actionError}</span>}
            <a href={`/api/goals/${goal.id}/export?format=json`} download
               className="text-[10px] px-2 py-0.5 rounded border border-zinc-700/50 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300">↓</a>
            <button data-action="edit" onClick={() => setShowEdit(!showEdit)}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${showEdit ? 'border-sky-700/60 bg-sky-900/30 text-sky-300' : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'}`}>
              ✎ Edit
            </button>
            {goal.status === 'archived' ? (
              <button onClick={handleRestore} disabled={archiving}
                      className="text-[10px] px-2 py-0.5 rounded border border-blue-800/50 bg-blue-900/20 text-blue-400 hover:bg-blue-900/40 disabled:opacity-50">
                {archiving ? '…' : 'Restore'}
              </button>
            ) : (<>
              <select
                value={goal.status}
                onChange={e => handleStatusChange(e.target.value)}
                disabled={!!actionBusy}
                className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700/50 bg-zinc-800/60 text-zinc-300 focus:outline-none focus:border-zinc-500 disabled:opacity-50 cursor-pointer"
              >
                <option value="active">Active</option>
                <option value="planned">Planned</option>
                <option value="paused">Paused</option>
                <option value="blocked">Blocked</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              {actionBusy && <span className="text-[10px] text-zinc-500">…</span>}
              <button onClick={() => handleStatusChange('archived')} disabled={archiving || !!actionBusy}
                      className="text-[10px] px-2 py-0.5 rounded border border-zinc-700/50 bg-zinc-800/50 text-zinc-500 hover:text-zinc-400 disabled:opacity-50">
                {archiving ? '…' : 'Archive'}
              </button>
              <button onClick={() => setShowDeleteConfirm(!showDeleteConfirm)}
                      className="text-[10px] px-2 py-0.5 rounded border border-red-900/50 bg-red-950/20 text-red-500 hover:text-red-400 hover:bg-red-950/40">
                🗑
              </button>
            </>)}
          </div>

          {/* Delete confirmation */}
          {showDeleteConfirm && (
            <div className="mt-2 p-2 rounded-lg bg-red-950/30 border border-red-800/50 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-red-300 flex-1">Delete permanently? This cannot be undone.</span>
              <button onClick={handleDelete} disabled={actionBusy === 'delete'}
                      className="text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white disabled:opacity-50">
                {actionBusy === 'delete' ? 'Deleting…' : 'Yes, Delete'}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)}
                      className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300">
                Cancel
              </button>
            </div>
          )}
        </div>
        )}

        {cardExpanded && showSchedule && (
          <ScheduleForm goal={goal} onClose={() => setShowSchedule(false)} />
        )}
        {cardExpanded && showEdit && (
          <GoalEditForm goal={goal} flat={flat} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); onRefresh?.() }} />
        )}
      </div>

      {hasChildren && !collapsed && (
        <div className="space-y-0">
          {visibleChildren.map((child) => (
            <GoalCard
              key={child.id}
              goal={child}
              depth={depth + 1}
              onTrigger={onTrigger}
              onFlag={onFlag}
              triggeredTaskId={undefined}
              taskStatus={allTaskStatuses?.[child.id]}
              allTaskStatuses={allTaskStatuses}
              filterStatuses={filterStatuses}
              filterLevels={filterLevels}
              searchText={searchText}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── summary table ──────────────────────────────────────────────────────────────

interface SummaryTableProps {
  flat: Goal[]
  onClickStatus?: (status: string) => void
  onClickLevel?: (level: string) => void
  onClickAll?: () => void
}

function SummaryTable({ flat, onClickStatus, onClickLevel, onClickAll }: SummaryTableProps) {
  const byStatus = flat.reduce<Record<string, number>>((acc, g) => {
    acc[g.status] = (acc[g.status] ?? 0) + 1
    return acc
  }, {})
  const byLevel = flat.reduce<Record<string, number>>((acc, g) => {
    acc[g.level] = (acc[g.level] ?? 0) + 1
    return acc
  }, {})
  const avgProgress = flat.length > 0
    ? Math.round(flat.reduce((s, g) => s + g.progress, 0) / flat.length)
    : 0

  const items: { label: string; value: number | string; color: string; onClick?: () => void; hint?: string }[] = [
    { label: 'Total Goals', value: flat.length, color: 'text-white', onClick: onClickAll, hint: 'Show all goals' },
    { label: 'Active', value: byStatus.active ?? 0, color: 'text-blue-400', onClick: () => onClickStatus?.('active'), hint: 'Filter active goals' },
    { label: 'Completed', value: byStatus.completed ?? 0, color: 'text-green-400', onClick: () => onClickStatus?.('completed'), hint: 'Filter completed goals' },
    { label: 'Blocked', value: byStatus.blocked ?? 0, color: (byStatus.blocked ?? 0) > 0 ? 'text-amber-400' : 'text-zinc-600', onClick: () => onClickStatus?.('blocked'), hint: 'Filter blocked goals' },
    { label: 'Avg Progress', value: `${avgProgress}%`, color: 'text-zinc-300' },
    { label: 'Milestones', value: byLevel.milestone ?? 0, color: 'text-zinc-300', onClick: () => onClickLevel?.('milestone'), hint: 'Filter milestones' },
    { label: 'Goals', value: byLevel.strategy ?? 0, color: 'text-indigo-300', onClick: () => onClickLevel?.('strategy'), hint: 'Filter goals' },
    { label: 'Vision Items', value: byLevel.vision ?? 0, color: 'text-purple-300', onClick: () => onClickLevel?.('vision'), hint: 'Filter vision items' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      {items.map(({ label, value, color, onClick, hint }) => (
        <div
          key={label}
          onClick={onClick}
          title={hint}
          className={`card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4 text-center ${onClick ? 'cursor-pointer hover:border-zinc-600/70 hover:bg-zinc-800/50 transition-all duration-150 active:scale-95' : ''}`}
        >
          <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">{label}</div>
          {onClick && <div className="text-[9px] text-zinc-700 mt-0.5">↓ jump to</div>}
        </div>
      ))}
    </div>
  )
}

// ── next steps ─────────────────────────────────────────────────────────────────

function NextSteps({ flat }: { flat: Goal[] }) {
  const active = flat
    .filter((g) => g.status === 'active' && g.level === 'milestone')
    .sort((a, b) => {
      if (a.target_date && b.target_date) return a.target_date.localeCompare(b.target_date)
      if (a.target_date) return -1
      if (b.target_date) return 1
      return a.priority - b.priority
    })
    .slice(0, 6)

  const blocked = flat.filter((g) => g.status === 'blocked')
  const planned = flat
    .filter((g) => g.status === 'planned' && g.level === 'milestone')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 4)

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4 border-l-4 border-l-blue-500">
        <h3 className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider mb-3">In Progress</h3>
        <div className="space-y-2">
          {active.length === 0 ? (
            <p className="text-xs text-zinc-600">Nothing active</p>
          ) : active.map((g) => (
            <div key={g.id} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 mt-1" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-zinc-300 leading-tight">{g.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500/60 rounded-full" style={{ width: `${g.progress}%` }} />
                  </div>
                  <span className="text-[10px] text-zinc-600">{g.progress}%</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4 border-l-4 border-l-amber-500">
        <h3 className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider mb-3">Blocked / Waiting</h3>
        <div className="space-y-2">
          {blocked.length === 0 ? (
            <p className="text-xs text-zinc-600">Nothing blocked</p>
          ) : blocked.map((g) => (
            <div key={g.id} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0 mt-1" />
              <div>
                <p className="text-xs text-zinc-300 leading-tight">{g.title}</p>
                {g.notes && <p className="text-[10px] text-amber-600/80 mt-0.5">{g.notes}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4 border-l-4 border-l-zinc-600">
        <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">Up Next</h3>
        <div className="space-y-2">
          {planned.length === 0 ? (
            <p className="text-xs text-zinc-600">Nothing planned</p>
          ) : planned.map((g) => (
            <div key={g.id} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 flex-shrink-0 mt-1" />
              <div>
                <p className="text-xs text-zinc-400 leading-tight">{g.title}</p>
                {g.target_date && (
                  <p className="text-[10px] text-zinc-600 mt-0.5">{g.target_date}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── calendar section ───────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  calendarName?: string
  calendarColor?: string
  allDay?: boolean
}

function CalendarSection() {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(true)

  useEffect(() => {
    const now = new Date().toISOString()
    const max = new Date(Date.now() + 30 * 86400000).toISOString()
    fetch(`/api/calendar/ical?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(max)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.configured === false) { setConfigured(false); return }
        setEvents((data.events ?? []).slice(0, 10))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (!configured) return null

  return (
    <div className="card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4">
      {loading ? (
        <div className="flex items-center gap-2 py-2">
          <div className="w-3 h-3 border-2 border-zinc-700 border-t-purple-400 rounded-full animate-spin" />
          <span className="text-xs text-zinc-600">Loading events…</span>
        </div>
      ) : events.length === 0 ? (
        <p className="text-xs text-zinc-600">No upcoming events in the next 30 days</p>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => {
            const dt = new Date(ev.start)
            const dateStr = dt.toLocaleDateString([], { month: 'short', day: 'numeric', weekday: 'short' })
            const timeStr = ev.allDay ? 'All day' : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            return (
              <div key={ev.id} className="flex items-start gap-3">
                <div
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5"
                  style={{ backgroundColor: ev.calendarColor ?? '#a78bfa' }}
                />
                <div className="flex-1 min-w-0 flex items-start gap-2">
                  <span className="text-[10px] font-mono bg-zinc-800/80 px-1.5 py-0.5 rounded text-purple-300 flex-shrink-0">{dateStr}</span>
                  <div className="min-w-0">
                    <p className="text-xs text-zinc-300 leading-tight truncate">{ev.title}</p>
                    <p className="text-[10px] text-zinc-600 mt-0.5">{timeStr}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── section header ─────────────────────────────────────────────────────────────

function SectionHeader({ title, collapsed, onToggle, count }: { title: string; collapsed: boolean; onToggle: () => void; count?: number }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between mb-3 group"
    >
      <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest group-hover:text-zinc-400 transition-colors">
        {title}
      </h2>
      <div className="flex items-center gap-2">
        {count !== undefined && (
          <span className="text-[10px] text-zinc-700">{count}</span>
        )}
        <span className="text-[10px] text-zinc-700 group-hover:text-zinc-500 transition-colors">
          {collapsed ? '▶' : '▼'}
        </span>
      </div>
    </button>
  )
}

// ── markdown toolbar ───────────────────────────────────────────────────────────

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (v: string) => void
}

const MD_TOOLS = [
  { label: 'B',   title: 'Bold',          wrap: ['**', '**'],   placeholder: 'bold text',    style: 'font-bold' },
  { label: 'I',   title: 'Italic',        wrap: ['_', '_'],     placeholder: 'italic text',  style: 'italic' },
  { label: 'S',   title: 'Strikethrough', wrap: ['~~', '~~'],   placeholder: 'struck text',  style: 'line-through' },
  { label: '<>',  title: 'Inline code',   wrap: ['`', '`'],     placeholder: 'code',         style: 'font-mono text-[10px]' },
  { label: '```', title: 'Code block',    wrap: ['```\n', '\n```'], placeholder: 'code block', style: 'font-mono text-[9px]' },
  { label: 'H2',  title: 'Heading 2',     prefix: '## ',        style: 'font-semibold' },
  { label: 'H3',  title: 'Heading 3',     prefix: '### ',       style: '' },
  { label: '—',   title: 'Divider',       insert: '\n---\n',    style: '' },
  { label: '•',   title: 'Bullet list',   prefix: '- ',         style: '' },
  { label: '1.',  title: 'Numbered list', prefix: '1. ',        style: '' },
  { label: '[ ]', title: 'Task item',     prefix: '- [ ] ',     style: 'font-mono text-[9px]' },
  { label: '🔗',  title: 'Link',          wrap: ['[', '](url)'], placeholder: 'link text',  style: '' },
] as const

function applyMarkdown(
  tool: (typeof MD_TOOLS)[number],
  textarea: HTMLTextAreaElement,
  value: string,
  onChange: (v: string) => void,
) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = value.slice(start, end)

  let newValue = value
  let newCursorStart = start
  let newCursorEnd = end

  if ('insert' in tool) {
    newValue = value.slice(0, start) + tool.insert + value.slice(end)
    newCursorStart = newCursorEnd = start + tool.insert.length
  } else if ('prefix' in tool) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    newValue = value.slice(0, lineStart) + tool.prefix + value.slice(lineStart)
    newCursorStart = start + tool.prefix.length
    newCursorEnd = end + tool.prefix.length
  } else if ('wrap' in tool) {
    const [open, close] = tool.wrap
    const text = selected || tool.placeholder
    newValue = value.slice(0, start) + open + text + close + value.slice(end)
    if (selected) {
      newCursorStart = start + open.length
      newCursorEnd = start + open.length + text.length
    } else {
      newCursorStart = start + open.length
      newCursorEnd = start + open.length + text.length
    }
  }

  onChange(newValue)
  requestAnimationFrame(() => {
    textarea.focus()
    textarea.setSelectionRange(newCursorStart, newCursorEnd)
  })
}

function MarkdownToolbar({ textareaRef, value, onChange }: MarkdownToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 bg-zinc-800/60 border border-zinc-700/60 border-b-0 rounded-t-md">
      {MD_TOOLS.map((tool) => (
        <button
          key={tool.title}
          type="button"
          title={tool.title}
          onClick={() => textareaRef.current && applyMarkdown(tool, textareaRef.current, value, onChange)}
          className={`text-[10px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 transition-colors ${tool.style}`}
        >
          {tool.label}
        </button>
      ))}
    </div>
  )
}

// ── markdown preview ───────────────────────────────────────────────────────────

function MarkdownPreview({ content }: { content: string }) {
  if (!content.trim()) {
    return <p className="text-xs text-zinc-600 italic">Nothing to preview yet…</p>
  }
  return (
    <div className="prose prose-invert prose-xs max-w-none text-zinc-300 text-xs leading-relaxed
      [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-zinc-100 [&_h1]:mb-2
      [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-zinc-200 [&_h2]:mb-1.5
      [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-zinc-300 [&_h3]:mb-1
      [&_p]:mb-2 [&_p]:leading-relaxed
      [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-2
      [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-2
      [&_li]:mb-0.5
      [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-purple-300 [&_code]:font-mono [&_code]:text-[10px]
      [&_pre]:bg-zinc-800/80 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mb-2 [&_pre]:overflow-x-auto
      [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-green-300
      [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-500 [&_blockquote]:italic
      [&_hr]:border-zinc-700 [&_hr]:my-3
      [&_a]:text-purple-400 [&_a]:underline
      [&_strong]:text-zinc-100 [&_strong]:font-semibold
      [&_input[type=checkbox]]:mr-1.5
      [&_table]:w-full [&_table]:text-xs [&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-zinc-700 [&_th]:px-2 [&_th]:py-1 [&_th]:border [&_th]:border-zinc-700 [&_th]:bg-zinc-800/60 [&_th]:font-semibold
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}

// ── notes editor (stateful, no DB — for creation forms) ──────────────────────

function NotesEditorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [items, setItems] = useState<string[]>(() => parseNotes(value))
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  function commit(next: string[]) {
    setItems(next)
    onChange(serializeNotes(next) ?? '')
  }

  function startEdit(idx: number) { setEditIdx(idx); setEditText(items[idx]) }

  function saveEdit() {
    if (editIdx === null) return
    const trimmed = editText.trim()
    const next = trimmed ? [...items] : items.filter((_, i) => i !== editIdx)
    if (trimmed) next[editIdx] = trimmed
    setEditIdx(null); commit(next)
  }

  function deleteItem(idx: number) { setEditIdx(null); commit(items.filter((_, i) => i !== idx)) }

  function addNote() {
    const next = [...items, '']
    setItems(next); setEditIdx(next.length - 1); setEditText('')
  }

  return (
    <div className="p-2.5 rounded-lg bg-zinc-900/50 border border-zinc-700/40 space-y-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Notes</span>
        <button type="button" onClick={addNote}
          className="text-[10px] px-2 py-0.5 rounded border border-zinc-600/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
          + Add note
        </button>
      </div>
      {items.length === 0 && (
        <p className="text-[10px] text-zinc-600 italic">No notes yet — click + Add note</p>
      )}
      {items.map((item, idx) => (
        <div key={idx} className="flex gap-2 items-start group/note">
          <span className="text-[10px] font-mono text-zinc-600 mt-0.5 flex-shrink-0 w-4 text-right">{idx + 1}.</span>
          {editIdx === idx ? (
            <div className="flex-1 space-y-1">
              <textarea
                autoFocus
                value={editText}
                onChange={e => setEditText(e.target.value)}
                rows={2}
                className="w-full bg-zinc-900/60 border border-zinc-600/50 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500 resize-none font-mono placeholder:text-zinc-600"
                placeholder="Note text…"
                onKeyDown={e => { if (e.key === 'Escape') setEditIdx(null); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() } }}
              />
              <div className="flex gap-1">
                <button type="button" onClick={saveEdit}
                  className="text-[10px] px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300">Save</button>
                <button type="button" onClick={() => setEditIdx(null)}
                  className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-start justify-between gap-1 group/item">
              <span className="text-xs text-zinc-400 leading-relaxed flex-1 break-words">{item || <span className="italic text-zinc-600">empty</span>}</span>
              <div className="flex gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0">
                <button type="button" onClick={() => startEdit(idx)} className="text-[10px] text-zinc-500 hover:text-zinc-300">✎</button>
                <button type="button" onClick={() => deleteItem(idx)} className="text-[10px] text-zinc-600 hover:text-red-400">✕</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── add goal modal ─────────────────────────────────────────────────────────────

interface AddGoalPanelProps {
  flat: Goal[]
  onClose: () => void
  onCreated: () => void
  initialLevel?: Goal['level']
}

const LEVEL_LABELS: Record<Goal['level'], string> = {
  vision: 'Vision', strategy: 'Goal', milestone: 'Milestone', objective: 'Task',
}

function AddGoalPanel({ flat, onClose, onCreated, initialLevel }: AddGoalPanelProps) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    level: (initialLevel ?? 'milestone') as Goal['level'],
    parent_id: '',
    status: 'planned' as Goal['status'],
    priority: 2,
    target_date: '',
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [descTab, setDescTab] = useState<'edit' | 'preview'>('edit')
  const descRef = useRef<HTMLTextAreaElement>(null)

  // Parent options derived from level
  const visions    = flat.filter(g => g.level === 'vision'    && g.status !== 'archived')
  const strategies = flat.filter(g => g.level === 'strategy'  && g.status !== 'archived')
  const milestones = flat.filter(g => g.level === 'milestone' && g.status !== 'archived')

  // Milestones grouped by parent goal for task parent picker
  const milestonesByGoal = strategies.map(s => ({
    goal: s,
    milestones: milestones.filter(m => m.parent_id === s.id),
  })).filter(g => g.milestones.length > 0)
  const orphanMilestones = milestones.filter(m => !strategies.find(s => s.id === m.parent_id))

  const parentRequired = form.level === 'milestone' || form.level === 'objective'
  const canSubmit = form.title.trim() && (!parentRequired || form.parent_id)

  function handleLevelChange(level: Goal['level']) {
    setForm(f => ({ ...f, level, parent_id: '' }))
    setError(null)
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { setError('Title is required'); return }
    if (parentRequired && !form.parent_id) {
      setError(form.level === 'milestone' ? 'Select a Goal parent' : 'Select a Milestone parent')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        level: form.level,
        status: form.status,
        priority: Number(form.priority),
      }
      if (form.description.trim()) payload.description = form.description.trim()
      if (form.parent_id) payload.parent_id = form.parent_id
      if (form.target_date) payload.target_date = form.target_date
      if (form.notes.trim()) payload.notes = form.notes.trim()

      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) { onCreated(); onClose() }
      else { const data = await res.json(); setError(data.error ?? 'Failed to create') }
    } catch {
      setError('Request failed')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full text-xs bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-zinc-200 focus:outline-none focus:border-purple-600 placeholder-zinc-600'
  const labelCls = 'text-[10px] font-semibold text-zinc-500 uppercase tracking-wider block mb-1'
  const tabBtn = (active: boolean) =>
    `text-[10px] px-2.5 py-1 rounded-t font-medium transition-colors ${active ? 'bg-zinc-900 text-zinc-200 border border-zinc-700 border-b-zinc-900' : 'text-zinc-500 hover:text-zinc-300'}`

  return (
    <div
      className="fixed inset-0 z-[200] flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={handleBackdrop}
    >
      <div
        className="w-full max-w-2xl bg-zinc-950 border-l border-zinc-800 flex flex-col h-full"
        style={{ animation: 'slideInRight 0.2s ease-out' }}
      >
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-200">New {LEVEL_LABELS[form.level]}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 p-5 space-y-4 overflow-y-auto">

          {/* Level selector — tab style */}
          <div>
            <label className={labelCls}>Type</label>
            <div className="grid grid-cols-4 gap-1">
              {(['vision', 'strategy', 'milestone', 'objective'] as Goal['level'][]).map(lv => (
                <button
                  key={lv}
                  type="button"
                  onClick={() => handleLevelChange(lv)}
                  className={`py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                    form.level === lv
                      ? 'bg-purple-900/50 border-purple-700/60 text-purple-200'
                      : 'bg-zinc-900/40 border-zinc-700/40 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {LEVEL_LABELS[lv]}
                </button>
              ))}
            </div>
          </div>

          {/* Parent picker — changes based on level */}
          {form.level === 'strategy' && visions.length > 0 && (
            <div>
              <label className={labelCls}>Vision (optional)</label>
              <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className={inputCls}>
                <option value="">No parent vision</option>
                {visions.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select>
            </div>
          )}

          {form.level === 'milestone' && (
            <div>
              <label className={labelCls}>Goal *</label>
              <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className={inputCls} required>
                <option value="" disabled>Select a Goal…</option>
                {strategies.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>
          )}

          {form.level === 'objective' && (
            <div>
              <label className={labelCls}>Milestone *</label>
              <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className={inputCls} required>
                <option value="" disabled>Select a Milestone…</option>
                {milestonesByGoal.map(({ goal: g, milestones: ms }) => (
                  <optgroup key={g.id} label={g.title}>
                    {ms.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
                  </optgroup>
                ))}
                {orphanMilestones.length > 0 && (
                  <optgroup label="— Other Milestones —">
                    {orphanMilestones.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          )}

          {/* Status + Priority + Target Date */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as Goal['status'] }))} className={inputCls}>
                <option value="active">Active</option>
                <option value="planned">Planned</option>
                <option value="paused">Paused</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Priority</label>
              <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) }))} className={inputCls}>
                <option value={0}>0 — Critical</option>
                <option value={1}>1 — High</option>
                <option value={2}>2 — Normal</option>
                <option value={3}>3 — Low</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Target Date</label>
              <input type="date" value={form.target_date} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} className={inputCls} />
            </div>
          </div>

          {/* Title */}
          <div>
            <label className={labelCls}>Title *</label>
            <input
              type="text"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder={`${LEVEL_LABELS[form.level]} title…`}
              className={inputCls}
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls}>Description</label>
              <div className="flex gap-0.5 -mb-px relative z-10">
                <button type="button" className={tabBtn(descTab === 'edit')} onClick={() => setDescTab('edit')}>Edit</button>
                <button type="button" className={tabBtn(descTab === 'preview')} onClick={() => setDescTab('preview')}>Preview</button>
              </div>
            </div>
            {descTab === 'edit' ? (
              <>
                <MarkdownToolbar textareaRef={descRef} value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} />
                <textarea
                  ref={descRef}
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Describe this… (supports **markdown**)"
                  rows={8}
                  className="w-full text-xs bg-zinc-900 border border-zinc-700 rounded-b-md px-3 py-2 text-zinc-200 focus:outline-none focus:border-purple-600 placeholder-zinc-600 resize-y font-mono leading-relaxed"
                />
              </>
            ) : (
              <div className="min-h-[180px] bg-zinc-900/60 border border-zinc-700 rounded-md px-3 py-2">
                <MarkdownPreview content={form.description} />
              </div>
            )}
          </div>

          {/* Notes — numbered list */}
          <NotesEditorField value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} />

          {error && (
            <p className="text-xs text-red-400 border border-red-900/50 rounded-md px-3 py-2 bg-red-950/20">{error}</p>
          )}

          <div className="flex gap-2 pt-2 pb-4">
            <button
              type="submit"
              disabled={saving || !canSubmit}
              className="flex-1 text-xs px-3 py-2 rounded-md border border-purple-700/60 bg-purple-900/40 text-purple-200 hover:bg-purple-900/60 disabled:opacity-50 font-semibold transition-colors"
            >
              {saving ? 'Saving…' : `Create ${LEVEL_LABELS[form.level]}`}
            </button>
            <button type="button" onClick={onClose}
              className="text-xs px-3 py-2 rounded-md border border-zinc-700/50 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

// ── Vision Health Widget ───────────────────────────────────────────────────────

interface TaskQueueHealth {
  jeff_urgent: Array<{ id: string; title: string; priority: number; updated_at: string }>
  waiting: Array<{ id: string; title: string; status: string; blocked_reason: string | null }>
  completed: Array<{ id: string; title: string; updated_at: string }>
}

function VisionHealth({ flat }: { flat: Goal[] }) {
  const [taskData, setTaskData] = useState<TaskQueueHealth | null>(null)
  const [open, setOpen] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const loadTasks = useCallback(() => {
    fetch('/api/taskqueue').then(r => r.json()).then((d: TaskQueueHealth) => {
      setTaskData(d)
      setLastRefresh(new Date())
    }).catch(() => {})
  }, [])

  useEffect(() => {
    loadTasks()
    const iv = setInterval(loadTasks, 30_000)
    return () => clearInterval(iv)
  }, [loadTasks])

  const now = Date.now()
  const week = 7 * 86_400_000

  // Jeff actions: pending_jeff_action + review_needed tasks
  const jeffTasks = taskData?.jeff_urgent ?? []

  // Blocked tasks from task queue (waiting bucket contains 'blocked' status)
  const blockedTasks = (taskData?.waiting ?? []).filter(t => t.status === 'blocked')

  // Blocked goals
  const blockedGoals = flat.filter(g => g.status === 'blocked' && g.level !== 'vision')

  // Tasks completed this week
  const tasksThisWeek = (taskData?.completed ?? []).filter(t =>
    now - new Date(t.updated_at).getTime() < week
  )

  // Goals completed this week
  const goalsThisWeek = flat.filter(g => {
    if (g.status !== 'completed' || !g.completed_at) return false
    return now - new Date(g.completed_at).getTime() < week
  })

  // Drift alerts: non-completed goals with past target_date and progress < 75
  const driftAlerts = flat.filter(g => {
    if (!g.target_date || g.status === 'completed' || g.status === 'archived') return false
    const isPast = new Date(g.target_date).getTime() < now
    return isPast && g.progress < 75
  }).sort((a, b) => (a.target_date ?? '').localeCompare(b.target_date ?? ''))

  const totalBlocked = blockedTasks.length + blockedGoals.length

  const metrics = [
    {
      label: 'Pending Jeff',
      value: jeffTasks.length,
      cls: jeffTasks.length > 0 ? 'text-rose-400' : 'text-zinc-500',
      bgCls: jeffTasks.length > 0 ? 'bg-rose-950/30 border-rose-900/40' : 'bg-zinc-900/30 border-zinc-800/40',
      dot: jeffTasks.length > 0 ? 'bg-rose-400' : null,
      desc: jeffTasks.length > 0 ? `${jeffTasks.length} task${jeffTasks.length !== 1 ? 's' : ''} awaiting action` : 'Queue clear',
    },
    {
      label: 'Blocked',
      value: totalBlocked,
      cls: totalBlocked > 0 ? 'text-amber-400' : 'text-zinc-500',
      bgCls: totalBlocked > 0 ? 'bg-amber-950/30 border-amber-900/40' : 'bg-zinc-900/30 border-zinc-800/40',
      dot: totalBlocked > 0 ? 'bg-amber-400' : null,
      desc: totalBlocked > 0
        ? `${blockedTasks.length} task${blockedTasks.length !== 1 ? 's' : ''}, ${blockedGoals.length} goal${blockedGoals.length !== 1 ? 's' : ''}`
        : 'No blockers',
    },
    {
      label: 'Velocity / 7d',
      value: tasksThisWeek.length + goalsThisWeek.length,
      cls: (tasksThisWeek.length + goalsThisWeek.length) > 0 ? 'text-emerald-400' : 'text-zinc-500',
      bgCls: 'bg-zinc-900/30 border-zinc-800/40',
      dot: null,
      desc: `${tasksThisWeek.length} task${tasksThisWeek.length !== 1 ? 's' : ''} + ${goalsThisWeek.length} goal${goalsThisWeek.length !== 1 ? 's' : ''} done`,
    },
    {
      label: 'Drift Alerts',
      value: driftAlerts.length,
      cls: driftAlerts.length > 0 ? 'text-orange-400' : 'text-zinc-500',
      bgCls: driftAlerts.length > 0 ? 'bg-orange-950/30 border-orange-900/40' : 'bg-zinc-900/30 border-zinc-800/40',
      dot: driftAlerts.length > 0 ? 'bg-orange-400' : null,
      desc: driftAlerts.length > 0
        ? `${driftAlerts.length} goal${driftAlerts.length !== 1 ? 's' : ''} past target date`
        : 'On track',
    },
  ]

  const refreshAgo = Math.round((now - lastRefresh.getTime()) / 1000)

  return (
    <div className="mb-6">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 mb-2 group"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 group-hover:text-zinc-400">Mission Control</span>
        {jeffTasks.length > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-rose-900/50 text-rose-300 text-[10px] font-bold animate-pulse">
            {jeffTasks.length} need action
          </span>
        )}
        {driftAlerts.length > 0 && jeffTasks.length === 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-orange-900/50 text-orange-300 text-[10px] font-bold">
            {driftAlerts.length} drifting
          </span>
        )}
        <span className="ml-auto text-zinc-700 text-[10px]">
          {taskData ? `${refreshAgo}s ago` : 'loading…'}
        </span>
        <span className="text-zinc-700 text-[10px]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {metrics.map(m => (
              <div key={m.label} className={`rounded-xl border p-3 ${m.bgCls}`}>
                <div className="flex items-center gap-1.5 mb-1">
                  {m.dot && <span className={`w-1.5 h-1.5 rounded-full ${m.dot} animate-pulse flex-shrink-0`} />}
                  <span className="text-[10px] text-zinc-600 uppercase tracking-widest">{m.label}</span>
                </div>
                <div className={`text-2xl font-bold tabular-nums ${m.cls}`}>{m.value}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5 truncate" title={m.desc}>{m.desc}</div>
              </div>
            ))}
          </div>

          {/* Jeff action queue */}
          {jeffTasks.length > 0 && (
            <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-3 mb-3">
              <div className="text-[10px] font-bold text-rose-400 uppercase tracking-widest mb-2">
                Pending Jeff Actions
              </div>
              <div className="space-y-1.5">
                {jeffTasks.slice(0, 6).map(t => {
                  const age = Math.round((now - new Date(t.updated_at).getTime()) / 3_600_000)
                  return (
                    <div key={t.id} className="flex items-center gap-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse flex-shrink-0" />
                      <span className="text-zinc-300 truncate flex-1">{t.title}</span>
                      <span className="text-zinc-600 font-mono text-[10px] flex-shrink-0">
                        {age < 1 ? '<1h' : `${age}h`}
                      </span>
                    </div>
                  )
                })}
                {jeffTasks.length > 6 && (
                  <div className="text-[10px] text-zinc-600 pl-3">+{jeffTasks.length - 6} more</div>
                )}
              </div>
            </div>
          )}

          {/* Blocked tasks */}
          {blockedTasks.length > 0 && (
            <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-3 mb-3">
              <div className="text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-2">
                Blocked Tasks
              </div>
              <div className="space-y-1.5">
                {blockedTasks.slice(0, 4).map(t => (
                  <div key={t.id} className="flex items-start gap-2 text-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <span className="text-zinc-300 truncate block">{t.title}</span>
                      {t.blocked_reason && (
                        <span className="text-zinc-600 text-[10px] truncate block">{t.blocked_reason}</span>
                      )}
                    </div>
                  </div>
                ))}
                {blockedTasks.length > 4 && (
                  <div className="text-[10px] text-zinc-600 pl-3">+{blockedTasks.length - 4} more</div>
                )}
              </div>
            </div>
          )}

          {/* Drift alerts */}
          {driftAlerts.length > 0 && (
            <div className="rounded-xl border border-orange-900/40 bg-orange-950/20 p-3 mb-3">
              <div className="text-[10px] font-bold text-orange-400 uppercase tracking-widest mb-2">
                Drift Alerts — Past Target Date
              </div>
              <div className="space-y-1.5">
                {driftAlerts.slice(0, 5).map(g => {
                  const daysLate = Math.round((now - new Date(g.target_date!).getTime()) / 86_400_000)
                  return (
                    <div key={g.id} className="flex items-center gap-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" />
                      <span className="text-zinc-300 truncate flex-1">{g.title}</span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-orange-500 font-mono text-[10px]">+{daysLate}d</span>
                        <div className="w-12 h-1 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-orange-500/60 rounded-full"
                            style={{ width: `${g.progress}%` }}
                          />
                        </div>
                        <span className="text-zinc-600 font-mono text-[10px]">{g.progress}%</span>
                      </div>
                    </div>
                  )
                })}
                {driftAlerts.length > 5 && (
                  <div className="text-[10px] text-zinc-600 pl-3">+{driftAlerts.length - 5} more</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Goals Archive Section ──────────────────────────────────────────────────────

function GoalsArchiveSection({ onRestore }: { onRestore: () => void }) {
  const [open, setOpen] = useState(false)
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/goals/archived')
      if (res.ok) { const d = await res.json(); setGoals(d.goals ?? []) }
    } catch { /* noop */ } finally { setLoading(false) }
  }

  useEffect(() => { if (open) load() }, [open])

  async function restore(id: string) {
    await fetch(`/api/goals/${id}/restore`, { method: 'POST' }).catch(() => {})
    await load()
    onRestore()
  }

  const LEVEL_COLOR: Record<string, string> = {
    vision: 'text-purple-400', strategy: 'text-indigo-400',
    milestone: 'text-blue-400', objective: 'text-zinc-400',
  }

  return (
    <div className="border border-zinc-800/50 rounded-xl overflow-hidden mt-4">
      <button
        onClick={() => { setOpen(o => !o); if (!open) load() }}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-900/60 hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">Archived Goals</span>
        {goals.length > 0 && <span className="text-[10px] text-zinc-600">{goals.length}</span>}
        <span className="ml-auto text-zinc-700 text-[10px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="p-3">
          {loading ? (
            <div className="flex justify-center py-4">
              <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
            </div>
          ) : goals.length === 0 ? (
            <p className="text-xs text-zinc-600 text-center py-4">No archived goals</p>
          ) : (
            <div className="space-y-1.5">
              {goals.map(g => (
                <div key={g.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-900/40 border border-zinc-800/40">
                  <span className={`text-[10px] font-semibold uppercase ${LEVEL_COLOR[g.level] ?? 'text-zinc-500'}`}>{g.level}</span>
                  <span className="text-xs text-zinc-400 flex-1 truncate">{g.title}</span>
                  <a href={`/api/goals/${g.id}/export?format=json`} download
                     className="text-[10px] text-zinc-600 hover:text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-800">↓</a>
                  <button
                    onClick={() => restore(g.id)}
                    className="text-[10px] px-2 py-0.5 rounded border border-blue-800/50 bg-blue-900/20 text-blue-400 hover:bg-blue-900/40"
                  >Restore</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Vision Header (collapsible section header for vision-level goals) ──────────

function VisionHeader({
  goal, flat = [], isCollapsed, onToggle, strategyCount, onRefresh,
}: {
  goal: Goal; flat?: Goal[]; isCollapsed: boolean; onToggle: () => void
  strategyCount: number; onRefresh: () => void
}) {
  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  async function updateStatus(status: string) {
    setBusy(status)
    await fetch(`/api/goals/${goal.id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => {})
    onRefresh(); setBusy(null)
  }

  async function handleDelete() {
    setBusy('delete')
    const res = await fetch(`/api/goals/${goal.id}/delete`, { method: 'POST' }).catch(() => null)
    if (res?.ok) onRefresh()
    setBusy(null); setShowDelete(false)
  }

  const [showNotes, setShowNotes] = useState(false)

  return (
    <div className="mb-10">
      <div className="flex items-center gap-3 pb-3 border-b-2 border-purple-900/40 group">
        <button onClick={onToggle} className="flex items-center gap-2.5 flex-1 text-left min-w-0">
          <span className="text-xs text-purple-700 group-hover:text-purple-500 flex-shrink-0">{isCollapsed ? '▶' : '▼'}</span>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-900/40 text-purple-400 border border-purple-800/40 uppercase tracking-wider flex-shrink-0">Vision</span>
          <h2 className="text-xl font-bold text-white truncate" style={{ textShadow: '0 0 24px rgba(167,139,250,0.3)' }}>{goal.title}</h2>
          <StatusBadge status={goal.status} />
          {strategyCount > 0 && <span className="text-[10px] text-zinc-600 flex-shrink-0">{strategyCount} {strategyCount === 1 ? 'goal' : 'goals'}</span>}
          {goal.notes && !showNotes && <NotesPopover notes={goal.notes} />}
        </button>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => { setShowNotes(v => !v); setShowEdit(false) }}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${showNotes ? 'border-amber-700/60 bg-amber-900/20 text-amber-300' : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-500 hover:text-amber-300'}`}
                  title="Notes">
            📓
          </button>
          <button onClick={() => { setShowEdit(v => !v); setShowNotes(false) }}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${showEdit ? 'border-sky-700/60 bg-sky-900/30 text-sky-300' : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'}`}>
            ✎
          </button>
          <select value={goal.status} onChange={e => updateStatus(e.target.value)} disabled={!!busy}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700/50 bg-zinc-800/60 text-zinc-300 focus:outline-none disabled:opacity-50 cursor-pointer">
            {['active','planned','paused','blocked','completed','cancelled'].map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>
            ))}
          </select>
          <button onClick={() => setShowDelete(v => !v)}
                  className="text-[10px] px-2 py-0.5 rounded border border-red-900/50 bg-red-950/20 text-red-500 hover:text-red-400">🗑</button>
        </div>
      </div>
      {goal.description && (
        <p className="text-sm text-zinc-500 mt-2 mb-1 ml-6 leading-relaxed">{goal.description}</p>
      )}
      {goal.notes && !showNotes && (
        <div className="ml-6 mt-1 mb-1 border-l-2 border-zinc-700/60 pl-2 max-h-20 overflow-y-auto">
          <NotesDisplay notes={goal.notes} />
        </div>
      )}
      {showEdit && (
        <div className="ml-6 mt-2">
          <GoalEditForm goal={goal} flat={flat} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); onRefresh() }} />
        </div>
      )}
      {showNotes && (
        <div className="ml-6 mt-2">
          <NotesList goal={goal} onSaved={() => { onRefresh() }} />
        </div>
      )}
      {showDelete && (
        <div className="ml-6 mt-2 p-2 rounded-lg bg-red-950/30 border border-red-800/50 flex items-center gap-2">
          <span className="text-xs text-red-300 flex-1">Delete &quot;{goal.title}&quot; permanently?</span>
          <button onClick={handleDelete} disabled={busy === 'delete'}
                  className="text-xs px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-white disabled:opacity-50">
            {busy === 'delete' ? '…' : 'Delete'}
          </button>
          <button onClick={() => setShowDelete(false)} className="text-xs px-3 py-1 rounded bg-zinc-700 text-zinc-300">Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── Strategy Header ─────────────────────────────────────────────────────────────

function StrategyHeader({
  goal, flat = [], isCollapsed, onToggle, milestoneCount, isDragOver, onRefresh,
}: {
  goal: Goal; flat?: Goal[]; isCollapsed: boolean; onToggle: () => void
  milestoneCount: number; isDragOver: boolean; onRefresh: () => void
}) {
  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  async function updateStatus(status: string) {
    setBusy(status)
    await fetch(`/api/goals/${goal.id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => {})
    onRefresh(); setBusy(null)
  }

  async function handleDelete() {
    setBusy('delete')
    const res = await fetch(`/api/goals/${goal.id}/delete`, { method: 'POST' }).catch(() => null)
    if (res?.ok) onRefresh()
    setBusy(null); setShowDelete(false)
  }

  return (
    <div className={`mb-4 rounded-xl p-3 border transition-all duration-150 ${isDragOver ? 'border-indigo-600/50 bg-indigo-900/15 ring-1 ring-indigo-500/30' : 'border-zinc-800/40 bg-zinc-900/20'}`}>
      <div className="flex items-center gap-2 group">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 text-left min-w-0">
          <span className="text-[10px] text-indigo-700 group-hover:text-indigo-500 flex-shrink-0">{isCollapsed ? '▶' : '▼'}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-400 border border-indigo-800/40 uppercase tracking-wider flex-shrink-0">Goal</span>
          <h3 className="text-base font-semibold text-zinc-200 truncate">{goal.title}</h3>
          <StatusBadge status={goal.status} />
          {milestoneCount > 0 && <span className="text-[10px] text-zinc-600 flex-shrink-0">{milestoneCount} milestone{milestoneCount !== 1 ? 's' : ''}</span>}
          {isDragOver && <span className="text-[10px] text-indigo-400 animate-pulse flex-shrink-0">↓ drop here</span>}
          {goal.notes && !showNotes && <NotesPopover notes={goal.notes} />}
        </button>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => { setShowNotes(v => !v); setShowEdit(false) }}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${showNotes ? 'border-amber-700/60 bg-amber-900/20 text-amber-300' : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-500 hover:text-amber-300'}`}
                  title="Notes">
            📓
          </button>
          <button onClick={() => { setShowEdit(v => !v); setShowNotes(false) }}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${showEdit ? 'border-sky-700/60 bg-sky-900/30 text-sky-300' : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'}`}>
            ✎
          </button>
          <select value={goal.status} onChange={e => updateStatus(e.target.value)} disabled={!!busy}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700/50 bg-zinc-800/60 text-zinc-300 focus:outline-none disabled:opacity-50 cursor-pointer">
            {['active','planned','paused','blocked','completed','cancelled'].map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>
            ))}
          </select>
          <button onClick={() => setShowDelete(v => !v)}
                  className="text-[10px] px-2 py-0.5 rounded border border-red-900/50 bg-red-950/20 text-red-500 hover:text-red-400">🗑</button>
        </div>
      </div>
      {goal.description && (
        <p className="text-xs text-zinc-500 mt-1.5 ml-5 leading-relaxed line-clamp-3">{goal.description}</p>
      )}
      {goal.notes && !showNotes && (
        <div className="ml-5 mt-1 border-l-2 border-zinc-700/60 pl-2 max-h-16 overflow-y-auto">
          <NotesDisplay notes={goal.notes} />
        </div>
      )}
      {showEdit && (
        <div className="ml-5 mt-2">
          <GoalEditForm goal={goal} flat={flat} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); onRefresh() }} />
        </div>
      )}
      {showNotes && (
        <div className="ml-5 mt-2">
          <NotesList goal={goal} onSaved={() => { onRefresh() }} />
        </div>
      )}
      {showDelete && (
        <div className="ml-5 mt-2 p-2 rounded-lg bg-red-950/30 border border-red-800/50 flex items-center gap-2">
          <span className="text-xs text-red-300 flex-1">Delete &quot;{goal.title}&quot; permanently?</span>
          <button onClick={handleDelete} disabled={busy === 'delete'}
                  className="text-xs px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-white disabled:opacity-50">
            {busy === 'delete' ? '…' : 'Delete'}
          </button>
          <button onClick={() => setShowDelete(false)} className="text-xs px-3 py-1 rounded bg-zinc-700 text-zinc-300">Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── HierarchyView ──────────────────────────────────────────────────────────────

interface HierarchyViewProps {
  flat: Goal[]
  onTrigger: (goal: Goal) => Promise<string>
  onFlag: (taskId: string) => Promise<void>
  triggeredTasks: Record<string, string>
  taskStatuses: Record<string, TaskStatus>
  filterStatuses: Set<string>
  filterLevels: Set<string>
  searchText: string
  onRefresh: () => void
}

function HierarchyView({
  flat, onTrigger, onFlag, triggeredTasks, taskStatuses,
  filterStatuses, filterLevels, searchText, onRefresh,
}: HierarchyViewProps) {
  const [dragItem, setDragItem] = useState<{ id: string; level: string } | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setCollapsedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function reparent(itemId: string, newParentId: string) {
    await fetch('/api/goals', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: itemId, parent_id: newParentId }),
    }).catch(() => {})
    onRefresh()
  }

  // Deduplicate flat by id before building the parent map (guards against
  // duplicate entries that can arise from concurrent SSE + refresh updates)
  const seenIds = new Set<string>()
  const dedupedFlat = flat.filter(g => { if (seenIds.has(g.id)) return false; seenIds.add(g.id); return true })

  // Build parent → sorted children map (exclude archived)
  const byParent = new Map<string | null, Goal[]>()
  for (const g of dedupedFlat) {
    if (g.status === 'archived') continue
    const key = g.parent_id ?? null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(g)
  }
  for (const ch of byParent.values()) ch.sort((a, b) => a.sort_order - b.sort_order || a.priority - b.priority)

  const roots = byParent.get(null) ?? []
  const visions = roots.filter(g => g.level === 'vision')
  const orphanedStrategies = roots.filter(g => g.level === 'strategy')
  const orphanedMilestones = roots.filter(g => g.level === 'milestone')

  function passes(g: Goal) {
    if (!filterStatuses.has(g.status)) return false
    if (!filterLevels.has(g.level)) return false
    if (searchText && !nodeMatchesSearch(g, searchText)) return false
    return true
  }

  function renderObjective(obj: Goal) {
    if (!passes(obj)) return null
    return (
      <div
        key={obj.id}
        draggable
        onDragStart={(e) => { e.stopPropagation(); setDragItem({ id: obj.id, level: 'objective' }) }}
        onDragEnd={() => { setDragItem(null); setDragOverId(null) }}
        className="cursor-grab active:cursor-grabbing"
      >
        <GoalCard
          goal={obj} flat={flat} depth={3}
          onTrigger={onTrigger} onFlag={onFlag}
          triggeredTaskId={triggeredTasks[obj.id]}
          taskStatus={taskStatuses[obj.id]}
          allTaskStatuses={taskStatuses}
          onRefresh={onRefresh}
        />
      </div>
    )
  }

  function renderMilestone(ms: Goal, orphaned = false) {
    const objectives = (byParent.get(ms.id) ?? []).filter(g => g.level === 'objective')
    const isDragTarget = dragItem?.level === 'objective' && dragOverId === ms.id
    const msVisible = passes(ms)
    const hasVisibleObj = objectives.some(passes)
    if (!msVisible && !hasVisibleObj) return null

    return (
      <div
        key={ms.id}
        className={`mb-2 rounded-lg transition-all duration-150 ${isDragTarget ? 'ring-1 ring-blue-500/50 bg-blue-900/5' : ''}`}
        onDragOver={dragItem?.level === 'objective' ? (e) => { e.preventDefault(); setDragOverId(ms.id) } : undefined}
        onDragLeave={dragItem?.level === 'objective' ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null) } : undefined}
        onDrop={dragItem?.level === 'objective' ? async (e) => {
          e.preventDefault(); e.stopPropagation(); setDragOverId(null)
          if (dragItem && dragItem.id !== ms.id) await reparent(dragItem.id, ms.id)
          setDragItem(null)
        } : undefined}
      >
        {msVisible && (
          <div
            draggable
            onDragStart={(e) => { e.stopPropagation(); setDragItem({ id: ms.id, level: 'milestone' }) }}
            onDragEnd={() => { setDragItem(null); setDragOverId(null) }}
            className="cursor-grab active:cursor-grabbing"
            title="Drag to move to a different strategy"
          >
            <GoalCard
              goal={ms} flat={flat} depth={orphaned ? 0 : 2}
              onTrigger={onTrigger} onFlag={onFlag}
              triggeredTaskId={triggeredTasks[ms.id]}
              taskStatus={taskStatuses[ms.id]}
              allTaskStatuses={taskStatuses}
              onRefresh={onRefresh}
            />
          </div>
        )}
        {isDragTarget && <div className="mx-4 mb-1 h-0.5 bg-blue-500/40 rounded-full" />}
        {objectives.length > 0 && (
          <div className="ml-6 space-y-0">
            {objectives.map(renderObjective)}
          </div>
        )}
      </div>
    )
  }

  function renderStrategy(strat: Goal, orphaned = false) {
    const milestones = (byParent.get(strat.id) ?? []).filter(g => g.level === 'milestone')
    const isCollapsed = collapsedIds.has(strat.id)
    const isDragTarget = dragItem?.level === 'milestone' && dragOverId === strat.id

    return (
      <div
        key={strat.id}
        className={orphaned ? 'mb-4' : 'mb-4 ml-4'}
        onDragOver={dragItem?.level === 'milestone' ? (e) => { e.preventDefault(); setDragOverId(strat.id) } : undefined}
        onDragLeave={dragItem?.level === 'milestone' ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null) } : undefined}
        onDrop={dragItem?.level === 'milestone' ? async (e) => {
          e.preventDefault(); e.stopPropagation(); setDragOverId(null)
          if (dragItem && dragItem.id !== strat.id) await reparent(dragItem.id, strat.id)
          setDragItem(null)
        } : undefined}
      >
        <StrategyHeader
          goal={strat}
          flat={flat}
          isCollapsed={isCollapsed}
          onToggle={() => toggle(strat.id)}
          milestoneCount={milestones.length}
          isDragOver={isDragTarget}
          onRefresh={onRefresh}
        />
        {!isCollapsed && (
          <div className="ml-4 space-y-0">
            {milestones.map(ms => renderMilestone(ms))}
            {milestones.length === 0 && (
              <div className={`py-3 text-center text-[11px] rounded-lg border border-dashed transition-colors ${isDragTarget ? 'border-indigo-600/50 text-indigo-500' : 'border-zinc-800/50 text-zinc-700'}`}>
                {isDragTarget ? 'Drop milestone here' : 'No milestones — drag one here or add below'}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderVision(vision: Goal) {
    const children = byParent.get(vision.id) ?? []
    const strategies = children.filter(g => g.level === 'strategy')
    const directMilestones = children.filter(g => g.level === 'milestone')
    const isCollapsed = collapsedIds.has(vision.id)

    return (
      <div key={vision.id}>
        <VisionHeader
          goal={vision}
          flat={flat}
          isCollapsed={isCollapsed}
          onToggle={() => toggle(vision.id)}
          strategyCount={strategies.length}
          onRefresh={onRefresh}
        />
        {!isCollapsed && (
          <div>
            {strategies.map(s => renderStrategy(s))}
            {directMilestones.map(ms => renderMilestone(ms))}
            {strategies.length === 0 && directMilestones.length === 0 && (
              <div className="ml-6 py-4 text-center text-xs text-zinc-700">
                No strategies or milestones yet — add one using the + Add Goal button
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const hasOrphans = orphanedStrategies.length > 0 || orphanedMilestones.length > 0

  if (visions.length === 0 && orphanedStrategies.length === 0 && orphanedMilestones.length === 0) {
    return <div className="text-zinc-600 text-sm text-center py-12">No goals match the current filters</div>
  }

  return (
    <div>
      {visions.map(renderVision)}
      {hasOrphans && (
        <div className={visions.length > 0 ? 'mt-6 pt-6 border-t border-zinc-800/40' : ''}>
          {visions.length > 0 && <div className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-4">Uncategorized</div>}
          {orphanedStrategies.map(s => renderStrategy(s, true))}
          {orphanedMilestones.map(ms => renderMilestone(ms, true))}
        </div>
      )}
      {dragItem && (
        <div className="fixed bottom-4 right-4 z-50 px-3 py-1.5 rounded-full bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-400 shadow-lg">
          Dragging {LEVEL_DISPLAY[dragItem.level] ?? dragItem.level} — drop on a {dragItem.level === 'milestone' ? 'goal' : 'milestone'}
        </div>
      )}
    </div>
  )
}

// ── page ───────────────────────────────────────────────────────────────────────

export default function GoalsPage() {
  const [flat, setFlat] = useState<Goal[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [addPanelLevel, setAddPanelLevel] = useState<Goal['level'] | null>(null)
  const [showNewDropdown, setShowNewDropdown] = useState(false)
  const [triggeredTasks, setTriggeredTasks] = useState<Record<string, string>>({})
  const [taskStatuses, setTaskStatuses] = useState<Record<string, TaskStatus>>({})

  // keyboard shortcuts
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null)
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false)
  const keyboardHelpTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // filters — persisted in localStorage
  const [filterStatuses, setFilterStatuses] = useState<Set<string>>(new Set(['active', 'planned', 'paused', 'blocked']))
  const [filterLevels, setFilterLevels] = useState<Set<string>>(new Set(ALL_LEVELS))
  const [sortBy, setSortBy] = useState<SortBy>('priority')

  // restore persisted filter state after hydration
  useEffect(() => {
    try {
      const savedStatuses = localStorage.getItem('goals_filterStatuses')
      if (savedStatuses) setFilterStatuses(new Set(JSON.parse(savedStatuses)))
      const savedLevels = localStorage.getItem('goals_filterLevels')
      if (savedLevels) setFilterLevels(new Set(JSON.parse(savedLevels)))
      const savedSort = localStorage.getItem('goals_sortBy') as SortBy
      if (savedSort) setSortBy(savedSort)
    } catch {}
  }, [])
  const [searchText, setSearchText] = useState('')

  // section collapse state
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const hierarchyRef = useRef<HTMLDivElement>(null)

  // keyboard handlers
  const allVisibleGoals = goals.length > 0
    ? sortGoals(goals.filter((g) => nodeMatchesFilter(g, filterStatuses, filterLevels, searchText)), sortBy)
    : []

  const handleKeyboardHelp = useCallback(() => {
    setShowKeyboardHelp(true)
    if (keyboardHelpTimeoutRef.current) clearTimeout(keyboardHelpTimeoutRef.current)
    keyboardHelpTimeoutRef.current = setTimeout(() => setShowKeyboardHelp(false), 3000)
  }, [])

  const handleOpenNewGoal = useCallback(() => {
    setShowNewDropdown(true)
    handleKeyboardHelp()
  }, [handleKeyboardHelp])

  const handleEditSelected = useCallback(() => {
    if (!selectedGoalId) {
      handleKeyboardHelp()
      return
    }
    const goal = flat.find((g) => g.id === selectedGoalId)
    if (goal) {
      const editBtn = document.querySelector(`[data-goal-id="${goal.id}"] [data-action="edit"]`) as HTMLButtonElement
      if (editBtn) editBtn.click()
      handleKeyboardHelp()
    }
  }, [selectedGoalId, flat, handleKeyboardHelp])

  const handleToggleDetails = useCallback(() => {
    if (!selectedGoalId) {
      handleKeyboardHelp()
      return
    }
    const goal = flat.find((g) => g.id === selectedGoalId)
    if (goal) {
      const toggleBtn = document.querySelector(`[data-goal-id="${goal.id}"] [data-action="toggle-details"]`) as HTMLButtonElement
      if (toggleBtn) toggleBtn.click()
      handleKeyboardHelp()
    }
  }, [selectedGoalId, flat, handleKeyboardHelp])

  const handleNavigateGoals = useCallback((direction: 'up' | 'down') => {
    if (allVisibleGoals.length === 0) {
      handleKeyboardHelp()
      return
    }

    setSelectedGoalId((currentId) => {
      const currentIndex = currentId
        ? allVisibleGoals.findIndex((g) => g.id === currentId)
        : -1

      let nextIndex: number
      if (direction === 'down') {
        nextIndex = currentIndex < allVisibleGoals.length - 1 ? currentIndex + 1 : 0
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : allVisibleGoals.length - 1
      }

      const nextGoal = allVisibleGoals[nextIndex]
      if (nextGoal) {
        setTimeout(() => {
          const elem = document.querySelector(`[data-goal-id="${nextGoal.id}"]`)
          if (elem) {
            elem.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }
        }, 0)
        return nextGoal.id
      }
      return currentId
    })
    handleKeyboardHelp()
  }, [allVisibleGoals, handleKeyboardHelp])

  useKeyboard({
    shortcuts: [
      {
        key: 'n',
        callback: handleOpenNewGoal,
        description: 'Open new goal'
      },
      {
        key: 'e',
        callback: handleEditSelected,
        description: 'Edit selected'
      },
      {
        key: 'd',
        callback: handleToggleDetails,
        description: 'Toggle details'
      },
      {
        key: 'ArrowDown',
        callback: () => handleNavigateGoals('down'),
        description: 'Next goal'
      },
      {
        key: 'ArrowUp',
        callback: () => handleNavigateGoals('up'),
        description: 'Previous goal'
      }
    ]
  })

  function toggleSection(s: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }

  // Persist filter state to localStorage
  useEffect(() => {
    try { localStorage.setItem('goals_filterStatuses', JSON.stringify([...filterStatuses])) } catch { /* ignore */ }
  }, [filterStatuses])
  useEffect(() => {
    try { localStorage.setItem('goals_filterLevels', JSON.stringify([...filterLevels])) } catch { /* ignore */ }
  }, [filterLevels])
  useEffect(() => {
    try { localStorage.setItem('goals_sortBy', sortBy) } catch { /* ignore */ }
  }, [sortBy])

  function toggleStatus(s: string) {
    setFilterStatuses((prev) => {
      const next = new Set(prev)
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }
  function toggleLevel(l: string) {
    setFilterLevels((prev) => {
      const next = new Set(prev)
      next.has(l) ? next.delete(l) : next.add(l)
      return next
    })
  }
  function resetFilters() {
    setFilterStatuses(new Set(ALL_STATUSES))
    setFilterLevels(new Set(ALL_LEVELS))
    setSearchText('')
    setSortBy('priority')
  }

  function scrollToHierarchy() {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      next.delete('hierarchy')
      return next
    })
    setTimeout(() => {
      hierarchyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  function handleSummaryClickStatus(status: string) {
    setFilterStatuses(new Set([status]))
    setFilterLevels(new Set(ALL_LEVELS))
    setSearchText('')
    scrollToHierarchy()
  }

  function handleSummaryClickLevel(level: string) {
    setFilterStatuses(new Set(ALL_STATUSES))
    setFilterLevels(new Set([level]))
    setSearchText('')
    scrollToHierarchy()
  }

  function handleSummaryClickAll() {
    resetFilters()
    scrollToHierarchy()
  }

  const applyUpdate = useCallback((updatedGoals: Goal[]) => {
    setFlat((prev) => {
      const map = new Map(prev.map((g) => [g.id, g]))
      updatedGoals.forEach((g) => map.set(g.id, g))
      const merged = Array.from(map.values())
      setGoals(buildTree(merged))
      return merged
    })
    setLastUpdated(new Date())
    setLoading(false)
  }, [])

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
      const merged = Array.from(flatMap.values())
      setFlat(merged)
      setGoals(buildTree(merged))
      setLastUpdated(new Date())
      setLoading(false)
    }

    es.onerror = () => { setLoading(false) }

    return () => es.close()
  }, [applyUpdate])

  // Poll task statuses every 10s + auto-advance milestones
  useEffect(() => {
    async function fetchTaskStatuses() {
      if (!flat.length) return
      const ids = flat.map((g) => g.id).join(',')
      try {
        const res = await fetch(`/api/goals/tasks?goalIds=${encodeURIComponent(ids)}`)
        if (!res.ok) return
        const data: { tasks: Record<string, TaskStatus> } = await res.json()
        setTaskStatuses(data.tasks ?? {})

        // DB trigger (trg_goal_progress_on_task_complete) handles writing progress to goals.
        // No frontend write-back needed — that would conflict with manual overrides.

        // Goal status is NOT auto-changed here — Jeff sets status manually.
      } catch { /* silent */ }
    }

    fetchTaskStatuses()
    const timer = setInterval(fetchTaskStatuses, 10000)
    return () => clearInterval(timer)
  }, [flat])

  async function handleTrigger(goal: Goal): Promise<string> {
    const res = await fetch('/api/goals/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goalId: goal.id, title: goal.title, description: goal.description, notes: goal.notes }),
    })
    if (!res.ok) throw new Error('Failed to trigger')
    const data = await res.json()
    setTriggeredTasks((prev) => ({ ...prev, [goal.id]: data.taskId }))
    return data.taskId
  }

  async function handleFlag(taskId: string): Promise<void> {
    const res = await fetch('/api/goals/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    if (!res.ok) throw new Error('Failed to flag')
  }

  function handleGoalArchived(id: string) {
    setFlat(prev => prev.filter(g => g.id !== id))
    setGoals(prev => prev.filter(g => g.id !== id))
  }

  function handleGoalRestored() {
    // Reload from server to get updated state
    fetch('/api/goals').then(r => r.json()).then(d => {
      if (d.flat) setFlat(d.flat)
      if (d.goals) setGoals(d.goals)
    }).catch(() => {})
  }

  function handleGoalCreated() {
    fetch('/api/goals').then(r => r.json()).then(d => {
      // Use applyUpdate (merge into existing flat) rather than replacing,
      // so the SSE flatMap and page state don't diverge and create duplicates
      if (d.flat) applyUpdate(d.flat)
    }).catch(() => {})
  }

  const calendarCollapsed = collapsedSections.has('calendar')
  const summaryCollapsed = collapsedSections.has('summary')
  const statusCollapsed = collapsedSections.has('status')
  const hierarchyCollapsed = collapsedSections.has('hierarchy')

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <LabSubNav />

      {/* Page header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-0.5">Vision &amp; Goals</h1>
          <p className="text-xs text-zinc-500">Track goals, trigger work, and schedule milestones</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setShowNewDropdown(v => !v)}
              className="text-xs px-3 py-1.5 rounded-full font-semibold bg-purple-900/30 border border-purple-700/50 text-purple-300 hover:bg-purple-900/50 hover:text-purple-200 transition-all flex items-center gap-1.5"
            >
              + New <span className="text-purple-500 text-[10px]">▼</span>
            </button>
            {showNewDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNewDropdown(false)} />
                <div
                  className="absolute right-0 top-full mt-1 rounded-xl border border-zinc-800 shadow-2xl z-50 overflow-hidden py-1 min-w-[140px]"
                  style={{ background: 'rgba(14,14,16,0.98)' }}
                >
                  {(['vision', 'strategy', 'milestone', 'objective'] as Goal['level'][]).map(lv => (
                    <button
                      key={lv}
                      onClick={() => { setAddPanelLevel(lv); setShowNewDropdown(false) }}
                      className="w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                    >
                      {LEVEL_LABELS[lv]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {loading && (
            <div className="w-3 h-3 border-2 border-zinc-700 border-t-blue-400 rounded-full animate-spin" />
          )}
          {lastUpdated && !loading && (
            <span className="text-[10px] text-zinc-600">
              live · {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <FilterBar
        filterStatuses={filterStatuses}
        filterLevels={filterLevels}
        onToggleStatus={toggleStatus}
        onToggleLevel={toggleLevel}
        onReset={resetFilters}
        sortBy={sortBy}
        onSortChange={setSortBy}
        searchText={searchText}
        onSearchChange={setSearchText}
      />

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-purple-400 rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Vision Health */}
          <VisionHealth flat={flat} />

          {/* Calendar section */}
          <div className="mb-6">
            <SectionHeader
              title="Upcoming Scheduled"
              collapsed={calendarCollapsed}
              onToggle={() => toggleSection('calendar')}
            />
            {!calendarCollapsed && <CalendarSection />}
          </div>

          {/* Summary table */}
          <div className="mb-6">
            <SectionHeader
              title="Summary"
              collapsed={summaryCollapsed}
              onToggle={() => toggleSection('summary')}
            />
            {!summaryCollapsed && (
              <SummaryTable
                flat={flat}
                onClickStatus={handleSummaryClickStatus}
                onClickLevel={handleSummaryClickLevel}
                onClickAll={handleSummaryClickAll}
              />
            )}
          </div>

          {/* Status overview */}
          <div className="mb-6">
            <SectionHeader
              title="Status Overview"
              collapsed={statusCollapsed}
              onToggle={() => toggleSection('status')}
            />
            {!statusCollapsed && <NextSteps flat={flat} />}
          </div>

          {/* Goal hierarchy */}
          <div ref={hierarchyRef}>
            <SectionHeader
              title="Goal Hierarchy"
              collapsed={hierarchyCollapsed}
              onToggle={() => toggleSection('hierarchy')}
              count={flat.filter(g => g.status !== 'archived').length}
            />
            {!hierarchyCollapsed && (
              <HierarchyView
                flat={flat}
                onTrigger={handleTrigger}
                onFlag={handleFlag}
                triggeredTasks={triggeredTasks}
                taskStatuses={taskStatuses}
                filterStatuses={filterStatuses}
                filterLevels={filterLevels}
                searchText={searchText}
                onRefresh={handleGoalRestored}
              />
            )}
          </div>
        </>
      )}

      {/* Archived goals section */}
      <GoalsArchiveSection onRestore={handleGoalRestored} />

      {addPanelLevel && (
        <AddGoalPanel
          flat={flat}
          onClose={() => setAddPanelLevel(null)}
          onCreated={handleGoalCreated}
          initialLevel={addPanelLevel}
        />
      )}

      {/* Keyboard help tooltip */}
      {showKeyboardHelp && (
        <div className="fixed bottom-4 right-4 bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg p-3 max-w-xs text-xs z-50 animate-in fade-in duration-200">
          <div className="font-semibold text-zinc-300 mb-2">Keyboard Shortcuts</div>
          <div className="space-y-1 text-zinc-400">
            <div className="flex justify-between gap-2">
              <kbd className="bg-zinc-800 px-1.5 py-0.5 rounded text-[10px] font-mono">N</kbd>
              <span>Open new goal</span>
            </div>
            <div className="flex justify-between gap-2">
              <kbd className="bg-zinc-800 px-1.5 py-0.5 rounded text-[10px] font-mono">E</kbd>
              <span>Edit selected</span>
            </div>
            <div className="flex justify-between gap-2">
              <kbd className="bg-zinc-800 px-1.5 py-0.5 rounded text-[10px] font-mono">D</kbd>
              <span>Toggle details</span>
            </div>
            <div className="flex justify-between gap-2">
              <kbd className="bg-zinc-800 px-1.5 py-0.5 rounded text-[10px] font-mono">↑↓</kbd>
              <span>Navigate goals</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
