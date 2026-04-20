import { NextRequest, NextResponse } from 'next/server'

const SUPA_HEADERS = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
})

const ALLOWED_FIELDS = ['title', 'description', 'notes', 'priority', 'target_date', 'tags', 'progress', 'level', 'parent_id', 'progress_locked']

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params
  const body = await req.json()

  const patch: Record<string, unknown> = {}
  for (const field of ALLOWED_FIELDS) {
    if (field in body) patch[field] = body[field]
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  // Always touch updated_at
  patch.updated_at = new Date().toISOString()

  const res = await fetch(`${url}/rest/v1/goals?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify(patch),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: 'Failed to update goal', detail: err }, { status: 500 })
  }

  const updated = await res.json()

  // Queue a review task only if the user requested one
  if (body.reviewAgent) {
    fetch(`${url}/rest/v1/task_queue`, {
      method: 'POST',
      headers: { ...SUPA_HEADERS(key), Prefer: 'return=minimal' },
      body: JSON.stringify({
        title: `Review updated goal: ${body.title ?? '(untitled)'}`,
        description: `Goal was edited via dashboard. Review for alignment, completeness, and any follow-up tasks needed. Goal ID: ${id}`,
        status: 'ready',
        priority: 3,
        source: 'dashboard',
        target: body.reviewAgent,
        goal_id: id,
        tags: ['goal-review', 'edited'],
      }),
    }).catch(() => {})
  }


  return NextResponse.json({ ok: true, goal: Array.isArray(updated) ? updated[0] : updated })
}
