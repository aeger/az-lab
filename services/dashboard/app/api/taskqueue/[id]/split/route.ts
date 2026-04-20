import { NextRequest, NextResponse } from 'next/server'

const SUPA_HEADERS = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
})

interface SubtaskInput {
  title: string
  description?: string
  priority?: number
  tags?: string[]
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params

  let body: { subtasks: SubtaskInput[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { subtasks } = body
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return NextResponse.json({ error: 'subtasks array is required' }, { status: 400 })
  }

  const headers = SUPA_HEADERS(key)

  // Fetch parent task
  const fetchRes = await fetch(
    `${url}/rest/v1/task_queue?id=eq.${id}&select=id,title,status,priority,goal_id,source,tags`,
    { headers, cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch parent task' }, { status: 500 })
  const rows = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const parent = rows[0]

  // Create subtasks
  const now = new Date().toISOString()
  const subtaskRows = subtasks.map((s, i) => ({
    title: s.title.trim(),
    description: s.description?.trim() ?? '',
    priority: s.priority ?? parent.priority,
    status: 'ready',
    source: 'dashboard',
    target: parent.target ?? 'wren',
    tags: s.tags ?? parent.tags ?? [],
    goal_id: parent.goal_id ?? null,
    parent_task_id: id,
    created_at: now,
    updated_at: now,
    attempt_count: 0,
    max_attempts: 3,
    failure_history: [],
  }))

  const createRes = await fetch(`${url}/rest/v1/task_queue`, {
    method: 'POST',
    headers,
    body: JSON.stringify(subtaskRows),
  })
  if (!createRes.ok) {
    const err = await createRes.text()
    return NextResponse.json({ error: 'Failed to create subtasks', detail: err }, { status: 500 })
  }
  const created = await createRes.json()

  // Mark parent as completed with split note
  const splitNote = `Split into ${subtasks.length} subtask${subtasks.length > 1 ? 's' : ''}:\n${subtasks.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`
  const patchRes = await fetch(`${url}/rest/v1/task_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      status: 'completed',
      result: splitNote,
      updated_at: now,
    }),
  })
  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: 'Subtasks created but failed to update parent', detail: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true, subtasks: created, parent_completed: true })
}
