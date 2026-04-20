import { NextRequest, NextResponse } from 'next/server'

// Returns task counts + most recent task per goal_id for the given goal IDs
// GET /api/goals/tasks?goalIds=uuid1,uuid2,...
export async function GET(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ tasks: {} })

  const { searchParams } = req.nextUrl
  const goalIds = searchParams.get('goalIds')
  if (!goalIds) return NextResponse.json({ tasks: {} })

  const ids = goalIds.split(',').filter(Boolean)
  if (!ids.length) return NextResponse.json({ tasks: {} })

  try {
    const res = await fetch(
      `${url}/rest/v1/task_queue?select=id,goal_id,status,title,created_at,updated_at,claimed_by,result,error&goal_id=in.(${ids.join(',')})&order=created_at.desc&limit=500`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: 'no-store',
      }
    )

    if (!res.ok) return NextResponse.json({ tasks: {} })

    const rows: {
      id: string
      goal_id: string
      status: string
      title: string
      created_at: string
      updated_at: string
      claimed_by: string | null
      result: string | null
      error: string | null
    }[] = await res.json()

    // Statuses that count as "actively running" — turns progress bar blue
    const RUNNING_STATUSES = new Set(['in_progress_agent', 'claimed', 'in_progress_jeff'])
    // Statuses that count as partial (50% credit)
    const PARTIAL_STATUSES = new Set(['review_needed', 'pending_jeff_action', 'pending_eval'])

    type TaskEntry = {
      id: string
      goal_id: string
      status: string
      updated_at: string
      claimed_by: string | null
      error: string | null
      counts: { active: number; done: number; blocked: number; partial: number; total: number; pct_complete: number }
    }

    const tasks: Record<string, TaskEntry> = {}
    const countsMap: Record<string, { active: number; done: number; blocked: number; partial: number }> = {}

    for (const row of rows) {
      // Track most recent task per goal (rows are desc by created_at)
      if (!tasks[row.goal_id]) {
        tasks[row.goal_id] = {
          id: row.id,
          goal_id: row.goal_id,
          status: row.status,
          updated_at: row.updated_at,
          claimed_by: row.claimed_by,
          error: row.error,
          counts: { active: 0, done: 0, blocked: 0, partial: 0, total: 0, pct_complete: 0 },
        }
      }

      // Skip archived tasks from counts
      if (row.status === 'archived') continue

      if (!countsMap[row.goal_id]) countsMap[row.goal_id] = { active: 0, done: 0, blocked: 0, partial: 0 }

      if (row.status === 'completed') {
        countsMap[row.goal_id].done++
      } else if (['blocked', 'failed', 'escalated'].includes(row.status)) {
        countsMap[row.goal_id].blocked++
      } else if (PARTIAL_STATUSES.has(row.status)) {
        countsMap[row.goal_id].partial++
      } else if (RUNNING_STATUSES.has(row.status)) {
        countsMap[row.goal_id].active++
      } else {
        countsMap[row.goal_id].active++
      }
    }

    // Attach counts to each task entry
    for (const goalId of Object.keys(tasks)) {
      const c = countsMap[goalId] ?? { active: 0, done: 0, blocked: 0, partial: 0 }
      const total = c.active + c.done + c.blocked + c.partial
      // partial tasks count as 50% complete for progress calculation
      const effectiveDone = c.done + c.partial * 0.5
      tasks[goalId].counts = {
        ...c,
        total,
        pct_complete: total > 0 ? Math.round((effectiveDone / total) * 100) : 0,
      }
    }

    return NextResponse.json({ tasks })
  } catch {
    return NextResponse.json({ tasks: {} })
  }
}
