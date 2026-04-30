import { NextRequest, NextResponse } from 'next/server'
import type { TaskItem } from '@/app/api/taskqueue/route'

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

  // Fetch current task to save pre-archive status
  const fetchRes = await fetch(
    `${url}/rest/v1/task_queue?id=eq.${id}&select=id,status,context`,
    { headers: SUPA_HEADERS(key), cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 })
  const rows: TaskItem[] = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const task = rows[0]
  if (task.status === 'archived') {
    return NextResponse.json({ ok: true, message: 'Already archived' })
  }

  const updatedContext = {
    ...(task.context ?? {}),
    archived_at: new Date().toISOString(),
    pre_archive_status: task.status,
  }

  const patchRes = await fetch(`${url}/rest/v1/task_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify({ status: 'archived', context: updatedContext }),
  })

  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: 'Failed to archive task', detail: err }, { status: 500 })
  }

  const updated: TaskItem[] = await patchRes.json()
  return NextResponse.json({ ok: true, task: updated[0] })
}
