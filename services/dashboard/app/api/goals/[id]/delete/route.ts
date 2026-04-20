import { NextRequest, NextResponse } from 'next/server'

const SUPA_HEADERS = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
})

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params

  // Safeguard: don't delete goals that have active/in-progress tasks
  const taskCheck = await fetch(
    `${url}/rest/v1/task_queue?goal_id=eq.${id}&status=in.(ready,pending,claimed,in_progress_agent,in_progress_jeff,pending_jeff_action,review_needed,blocked)&select=id&limit=1`,
    { headers: SUPA_HEADERS(key), cache: 'no-store' }
  )
  if (taskCheck.ok) {
    const activeTasks = await taskCheck.json()
    if (activeTasks.length > 0) {
      return NextResponse.json({
        error: 'Goal has active tasks — cancel or complete them first',
        blocked: true,
      }, { status: 409 })
    }
  }

  const res = await fetch(`${url}/rest/v1/goals?id=eq.${id}`, {
    method: 'DELETE',
    headers: SUPA_HEADERS(key),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: 'Failed to delete goal', detail: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
