import { NextRequest, NextResponse } from 'next/server'

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

// JeffLoop extras stored in the context JSONB column
export interface TaskContext {
  checklist?: ChecklistItem[]
  jeff_notes?: string
  context_summary?: string
  archived_at?: string
  pre_archive_status?: string
  action_required?: string
  recurring_schedule?: string   // 'daily' | 'weekly' | cron expr | null
  [key: string]: unknown
}

export interface TaskItem {
  id: string
  title: string
  description: string | null
  status: string
  priority: number
  source: string | null
  target: string | null
  claimed_by: string | null
  claimed_at: string | null
  created_at: string
  updated_at: string
  tags: string[] | null
  result: string | null
  error: string | null
  blocked_reason: string | null
  failure_mode: string | null
  attempt_count: number
  goal_id: string | null
  parent_task_id: string | null
  context: TaskContext | null
  blocked_by_task_ids: string[] | null
}

export interface TaskQueueData {
  problems: TaskItem[]
  waiting: TaskItem[]
  active: TaskItem[]
  recent: TaskItem[]
  completed: TaskItem[]
  summary24h: Record<string, number>
}

// Keep old export name for any existing imports
export type TaskQueueStats = TaskQueueData

const SELECT = 'id,title,description,status,priority,source,target,claimed_by,claimed_at,created_at,updated_at,tags,result,error,blocked_reason,failure_mode,attempt_count,goal_id,parent_task_id,context,blocked_by_task_ids'

// JeffLoop new statuses + legacy statuses all live as plain TEXT — no constraint change needed
const JEFF_URGENT = ['pending_jeff_action', 'review_needed']
const WAITING = ['blocked', 'delegated', 'pending_eval']
const ACTIVE = ['claimed', 'in_progress_agent', 'in_progress_jeff']
const PROBLEM = ['failed', 'escalated']

const COMPLETED_PAGE_SIZE = 25

export async function GET(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  const completedOffset = parseInt(req.nextUrl.searchParams.get('completedOffset') ?? '0', 10) || 0

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
  const base = `${url}/rest/v1/task_queue`
  const opts = { headers, cache: 'no-store' as const }

  // Build IN filter for PostgREST: or=(status.eq.a,status.eq.b,...)
  function inFilter(statuses: string[]) {
    return `or=(${statuses.map(s => `status.eq.${s}`).join(',')})`
  }

  try {
    const [jeffUrgentRes, problemsRes, waitingRes, activeRes, recentRes, completedRes, summary24hRes, completedCountRes] = await Promise.all([
      // Jeff urgent: pending_jeff_action and review_needed — highest priority
      fetch(`${base}?select=${SELECT}&${inFilter(JEFF_URGENT)}&order=updated_at.desc&limit=20`, opts),
      // Problems: failed or escalated
      fetch(`${base}?select=${SELECT}&${inFilter(PROBLEM)}&order=updated_at.desc&limit=20`, opts),
      // Waiting: blocked, delegated, pending_eval
      fetch(`${base}?select=${SELECT}&${inFilter(WAITING)}&order=updated_at.desc&limit=10`, opts),
      // Active: claimed/in_progress_*
      fetch(`${base}?select=${SELECT}&${inFilter(ACTIVE)}&order=claimed_at.asc`, opts),
      // Recent 20 non-archived non-completed by updated_at (active pipeline view)
      fetch(`${base}?select=${SELECT}&status=neq.archived&status=neq.completed&order=updated_at.desc&limit=20`, opts),
      // Completed: paginated by updated_at
      fetch(`${base}?select=${SELECT}&status=eq.completed&order=updated_at.desc&limit=${COMPLETED_PAGE_SIZE}&offset=${completedOffset}`, opts),
      // Last 24h for summary
      fetch(`${base}?select=status&updated_at=gte.${new Date(Date.now() - 86400000).toISOString()}`, opts),
      // Total completed count for pagination
      fetch(`${base}?select=id&status=eq.completed`, { headers: { ...headers, Prefer: 'count=exact' }, cache: 'no-store' }),
    ])

    const [jeffUrgentRaw, problemsRaw, waitingRaw, activeRaw, recentRaw, completedRaw, summary24hRaw]: [
      TaskItem[], TaskItem[], TaskItem[], TaskItem[], TaskItem[], TaskItem[], Array<{ status: string }>
    ] = await Promise.all([
      jeffUrgentRes.ok ? jeffUrgentRes.json() : [],
      problemsRes.ok ? problemsRes.json() : [],
      waitingRes.ok ? waitingRes.json() : [],
      activeRes.ok ? activeRes.json() : [],
      recentRes.ok ? recentRes.json() : [],
      completedRes.ok ? completedRes.json() : [],
      summary24hRes.ok ? summary24hRes.json() : [],
    ])
    const completedTotal = parseInt(completedCountRes.headers.get('content-range')?.split('/')[1] ?? '0', 10) || 0

    const summary24h: Record<string, number> = {}
    for (const { status } of summary24hRaw) {
      summary24h[status] = (summary24h[status] ?? 0) + 1
    }

    // Merge jeff_urgent into problems for the "problems" bucket (displayed together)
    const mergedProblems = [...jeffUrgentRaw, ...problemsRaw].filter(
      (t, i, arr) => arr.findIndex(x => x.id === t.id) === i
    )

    return NextResponse.json({
      problems: mergedProblems,
      waiting: waitingRaw,
      active: activeRaw,
      recent: recentRaw,
      completed: completedRaw,
      completedTotal,
      completedOffset,
      completedPageSize: COMPLETED_PAGE_SIZE,
      summary24h,
      jeff_urgent: jeffUrgentRaw,
    } satisfies TaskQueueData & { jeff_urgent: TaskItem[]; completed: TaskItem[]; completedTotal: number; completedOffset: number; completedPageSize: number })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch task queue' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const body = await req.json()
    const { title, description, priority, source, target, tags, status, recurring_schedule, context } = body
    if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })

    // Merge recurring_schedule into context JSONB (no schema migration required)
    const taskContext: TaskContext = { ...(context ?? {}) }
    if (recurring_schedule?.trim()) {
      taskContext.recurring_schedule = recurring_schedule.trim()
    }

    const res = await fetch(`${url}/rest/v1/task_queue`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        title: title.trim(),
        description: description?.trim() || null,
        status: status ?? 'ready',
        priority: priority ?? 2,
        source: source?.trim() || 'dashboard',
        target: target?.trim() || null,
        tags: tags ?? [],
        context: Object.keys(taskContext).length ? taskContext : null,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to create task', detail: err }, { status: 500 })
    }

    const rows = await res.json()
    return NextResponse.json({ task: Array.isArray(rows) ? rows[0] : rows }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const body = await req.json()
    const { id, ...fields } = body
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const allowed = ['status', 'priority', 'result', 'error', 'blocked_reason', 'context', 'tags']
    const patch: Record<string, unknown> = {}
    for (const k of allowed) {
      if (k in fields) patch[k] = fields[k]
    }
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'No fields to update' }, { status: 400 })

    const res = await fetch(`${url}/rest/v1/task_queue?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update task', detail: err }, { status: 500 })
    }

    const updated = await res.json()
    return NextResponse.json({ task: Array.isArray(updated) ? updated[0] : updated })
  } catch {
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })
  }
}
