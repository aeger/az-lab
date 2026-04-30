import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const { taskId, taskTitle, taskStatus } = await req.json()
    if (!taskId || typeof taskId !== 'string') {
      return NextResponse.json({ error: 'Invalid taskId' }, { status: 400 })
    }

    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }

    // Queue a new claude-code task to examine and resolve the stuck task
    const body = JSON.stringify({
      title: `Examine and resolve stuck task: ${taskTitle ?? taskId}`,
      description: `Task ${taskId} (status: ${taskStatus ?? 'unknown'}) appears stalled or needs attention. Examine it, determine the correct next action, and execute it. If it was pending_eval, evaluate the result and mark completed or failed. If blocked, investigate and unblock. If failed, diagnose and retry or escalate.`,
      status: 'pending',
      target: 'claude-code',
      priority: 1,
      source: 'dashboard',
      tags: ['flagged', 'maintenance'],
      context: { flagged_task_id: taskId, flagged_status: taskStatus },
    })

    const res = await fetch(`${url}/rest/v1/task_queue`, {
      method: 'POST',
      headers,
      body,
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: `Queue insert failed: ${err}` }, { status: 500 })
    }

    const [created] = await res.json()
    return NextResponse.json({ success: true, newTaskId: created?.id })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
