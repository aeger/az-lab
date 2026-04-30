import { NextRequest, NextResponse } from 'next/server'
import type { ChecklistItem, TaskItem } from '@/app/api/taskqueue/route'

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

  let body: { items?: ChecklistItem[]; toggle?: { id: string; done: boolean }; add?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Fetch current context
  const fetchRes = await fetch(
    `${url}/rest/v1/task_queue?id=eq.${id}&select=id,context`,
    { headers: SUPA_HEADERS(key), cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 })
  const rows: TaskItem[] = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const ctx = (rows[0].context ?? {}) as Record<string, unknown>
  let checklist: ChecklistItem[] = Array.isArray(ctx.checklist) ? (ctx.checklist as ChecklistItem[]) : []

  if (body.items) {
    // Full replacement
    checklist = body.items
  } else if (body.toggle) {
    // Toggle single item
    checklist = checklist.map(item =>
      item.id === body.toggle!.id ? { ...item, done: body.toggle!.done } : item
    )
  } else if (body.add) {
    // Add new item
    checklist = [...checklist, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: body.add,
      done: false,
    }]
  }

  const updatedContext = { ...ctx, checklist }

  const patchRes = await fetch(`${url}/rest/v1/task_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify({ context: updatedContext }),
  })

  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: 'Failed to update checklist', detail: err }, { status: 500 })
  }

  const updated: TaskItem[] = await patchRes.json()
  return NextResponse.json({ ok: true, checklist, task: updated[0] })
}
