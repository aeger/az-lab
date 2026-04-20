import { NextRequest, NextResponse } from 'next/server'

interface ImportPayload {
  tasks: Array<{
    title: string
    description?: string
    status?: string
    priority?: number
    source?: string
    target?: string
    tags?: string[]
    context?: Record<string, unknown>
  }>
}

export async function POST(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  let payload: ImportPayload
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!Array.isArray(payload?.tasks) || payload.tasks.length === 0) {
    return NextResponse.json({ error: 'No tasks to import' }, { status: 400 })
  }

  if (payload.tasks.length > 100) {
    return NextResponse.json({ error: 'Max 100 tasks per import' }, { status: 400 })
  }

  // Sanitize each task: strip id/created_at/updated_at, default status to 'backlog'
  const toInsert = payload.tasks.map(t => {
    if (!t.title?.trim()) throw new Error('Each task must have a title')
    return {
      title: t.title.trim(),
      description: t.description ?? null,
      status: t.status ?? 'backlog',
      priority: t.priority ?? 2,
      source: t.source ?? 'import',
      target: t.target ?? null,
      tags: t.tags ?? null,
      context: t.context ?? null,
      attempt_count: 0,
    }
  })

  try {
    const res = await fetch(`${url}/rest/v1/task_queue`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(toInsert),
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to import tasks', detail: err }, { status: 500 })
    }

    const created = await res.json()
    const ids = Array.isArray(created) ? created.map((t: { id: string }) => t.id) : []
    return NextResponse.json({ ok: true, count: ids.length, ids }, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Import failed'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}
