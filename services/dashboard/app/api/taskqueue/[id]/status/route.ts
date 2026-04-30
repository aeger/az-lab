import { NextRequest, NextResponse } from 'next/server'
import { notifyJeff } from '@/lib/discord-notify'
import type { TaskItem } from '@/app/api/taskqueue/route'

// Valid transitions: from → allowed_to[]
const TRANSITIONS: Record<string, string[]> = {
  // New JeffLoop statuses
  backlog:              ['ready', 'cancelled', 'in_progress_jeff'],
  ready:                ['in_progress_agent', 'in_progress_jeff', 'backlog', 'cancelled'],
  in_progress_agent:    ['pending_jeff_action', 'review_needed', 'blocked', 'completed', 'ready', 'cancelled'],
  in_progress_jeff:     ['review_needed', 'completed', 'blocked', 'ready', 'in_progress_agent', 'hand_back'],
  pending_jeff_action:  ['in_progress_jeff', 'in_progress_agent', 'completed', 'cancelled', 'blocked'],
  review_needed:        ['completed', 'in_progress_jeff', 'in_progress_agent', 'cancelled'],
  blocked:              ['ready', 'in_progress_agent', 'in_progress_jeff', 'cancelled'],
  completed:            ['ready'],  // Reopen
  cancelled:            ['ready'],  // Restore
  archived:             [],         // Use restore endpoint
  // Legacy status compat
  pending:              ['ready', 'cancelled', 'backlog', 'in_progress_agent', 'claimed'],
  claimed:              ['in_progress_agent', 'pending_jeff_action', 'review_needed', 'blocked', 'completed', 'failed'],
  failed:               ['ready', 'cancelled', 'pending_jeff_action', 'in_progress_agent'],
  escalated:            ['pending_jeff_action', 'review_needed', 'ready', 'cancelled'],
  delegated:            ['in_progress_agent', 'pending_jeff_action', 'review_needed', 'ready'],
  pending_eval:         ['review_needed', 'ready', 'completed', 'cancelled'],
  expired:              ['ready', 'cancelled'],
}

// Statuses that MUST trigger a Discord notification to Jeff
const NOTIFY_STATUSES = new Set(['pending_jeff_action', 'review_needed'])

const SUPA_HEADERS = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params

  let body: { status: string; jeff_notes?: string; context_summary?: string; action_required?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const newStatus = body.status
  if (!newStatus) return NextResponse.json({ error: 'Missing status' }, { status: 400 })

  // Fetch current task
  const fetchRes = await fetch(
    `${url}/rest/v1/task_queue?id=eq.${id}&select=id,title,status,context`,
    { headers: SUPA_HEADERS(key), cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 })
  const rows: TaskItem[] = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const task = rows[0]
  const currentStatus = task.status

  // Check archived guard
  if (currentStatus === 'archived') {
    return NextResponse.json(
      { error: 'Cannot change status of archived task. Use restore endpoint.' },
      { status: 422 }
    )
  }

  // Validate transition (allow same status as no-op)
  if (newStatus !== currentStatus) {
    const allowed = TRANSITIONS[currentStatus] ?? []
    if (!allowed.includes(newStatus)) {
      return NextResponse.json(
        { error: 'Invalid status transition', from: currentStatus, to: newStatus, allowed },
        { status: 422 }
      )
    }
  }

  // Merge JeffLoop extras into context JSONB
  const existingContext = (task.context ?? {}) as Record<string, unknown>
  const updatedContext: Record<string, unknown> = { ...existingContext }
  if (body.jeff_notes !== undefined) updatedContext.jeff_notes = body.jeff_notes
  if (body.context_summary !== undefined) updatedContext.context_summary = body.context_summary
  if (body.action_required !== undefined) updatedContext.action_required = body.action_required

  // If moving to in_progress_jeff, ensure checklist exists (empty array default)
  if (newStatus === 'in_progress_jeff' && !updatedContext.checklist) {
    updatedContext.checklist = []
  }

  const patch: Record<string, unknown> = {
    status: newStatus,
    context: updatedContext,
  }

  // Set claimed_at when agent picks up a task
  if (newStatus === 'in_progress_agent' || newStatus === 'claimed') {
    patch.claimed_at = new Date().toISOString()
  }

  const patchRes = await fetch(`${url}/rest/v1/task_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify(patch),
  })

  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: 'Failed to update status', detail: err }, { status: 500 })
  }

  const updated: TaskItem[] = await patchRes.json()
  const updatedTask = updated[0]

  // If no rows returned, the PATCH matched nothing (RLS or wrong ID)
  if (!updatedTask) {
    return NextResponse.json(
      { error: 'Update matched no rows — task may be protected by RLS or ID is wrong' },
      { status: 422 }
    )
  }

  // Auto-notify Jeff when task enters an attention-required status
  if (NOTIFY_STATUSES.has(newStatus)) {
    const ctx = updatedTask?.context ?? updatedContext
    notifyJeff({
      title: task.title,
      taskId: id,
      status: newStatus as 'pending_jeff_action' | 'review_needed',
      contextSummary: (ctx as Record<string, unknown>)?.context_summary as string ?? null,
      actionRequired: (ctx as Record<string, unknown>)?.action_required as string ?? null,
    }).catch(() => {})
  }

  // Sync goal progress whenever a linked task changes status (fire-and-forget)
  const goalId = (updatedTask as unknown as Record<string, unknown>)?.goal_id as string | null
  if (goalId) {
    syncGoalProgress(url, key, goalId).catch(() => {})
  }

  return NextResponse.json({ ok: true, task: updatedTask })
}

async function syncGoalProgress(url: string, key: string, goalId: string): Promise<void> {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const PARTIAL = new Set(['review_needed', 'pending_jeff_action', 'pending_eval'])
  const RUNNING = new Set(['in_progress_agent', 'claimed', 'in_progress_jeff'])

  const res = await fetch(
    `${url}/rest/v1/task_queue?goal_id=eq.${goalId}&status=neq.archived&select=status`,
    { headers, cache: 'no-store' }
  )
  if (!res.ok) return

  const rows: { status: string }[] = await res.json()
  if (!rows.length) return

  let done = 0, partial = 0, total = 0
  for (const r of rows) {
    total++
    if (r.status === 'completed') done++
    else if (PARTIAL.has(r.status)) partial++
    else if (RUNNING.has(r.status)) { /* active — no progress credit yet */ }
    // blocked/failed count toward total but not done
  }

  const pct = total > 0 ? Math.round(((done + partial * 0.5) / total) * 100) : 0

  // Only update progress percentage — never auto-change goal status.
  // Status must be set manually by Jeff to prevent overriding intentional resets.
  const patch: Record<string, unknown> = { progress: pct }

  await fetch(`${url}/rest/v1/goals?id=eq.${goalId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  })
}
