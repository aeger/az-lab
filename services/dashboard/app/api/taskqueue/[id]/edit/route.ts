import { NextRequest, NextResponse } from 'next/server'

const SUPA_HEADERS = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params

  let body: { title?: string; description?: string; priority?: number; tags?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (body.title !== undefined) patch.title = body.title.trim()
  if (body.description !== undefined) patch.description = body.description.trim() || null
  if (body.priority !== undefined) patch.priority = body.priority
  if (body.tags !== undefined) patch.tags = body.tags

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const res = await fetch(`${url}/rest/v1/task_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify(patch),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: 'Failed to update task', detail: err }, { status: 500 })
  }

  const updated = await res.json()
  if (!updated[0]) {
    return NextResponse.json({ error: 'Task not found or no change' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, task: updated[0] })
}
