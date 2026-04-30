import { NextRequest, NextResponse } from 'next/server'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params
  const { agent, notes } = await req.json()

  if (!agent) return NextResponse.json({ error: 'agent required' }, { status: 400 })

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  }

  // Fetch goal title for context
  const goalRes = await fetch(`${url}/rest/v1/goals?id=eq.${id}&select=title,level`, { headers })
  const goals = await goalRes.json()
  const goal = goals?.[0]

  const res = await fetch(`${url}/rest/v1/task_queue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `Review notes: ${goal?.title ?? id}`,
      description: `Notes added to ${goal?.level ?? 'goal'} "${goal?.title ?? id}" — please review for alignment, follow-up actions, or blockers:\n\n${notes}`,
      status: 'ready',
      priority: 2,
      source: 'dashboard',
      target: agent,
      goal_id: id,
      tags: ['notes-review'],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: 'Failed to queue review', detail: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
