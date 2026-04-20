import { NextRequest, NextResponse } from 'next/server'
import type { Goal } from '@/app/api/goals/route'

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

  const fetchRes = await fetch(
    `${url}/rest/v1/goals?id=eq.${id}&select=id,status,notes`,
    { headers: SUPA_HEADERS(key), cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch goal' }, { status: 500 })
  const rows: Goal[] = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Goal not found' }, { status: 404 })

  const goal = rows[0]
  if (goal.status === 'archived') return NextResponse.json({ ok: true, message: 'Already archived' })

  // Store pre-archive status in notes with sentinel prefix
  const archiveMeta = `[archived:${goal.status}:${new Date().toISOString()}]`
  const existingNotes = goal.notes ?? ''
  const updatedNotes = archiveMeta + (existingNotes ? '\n' + existingNotes : '')

  const patchRes = await fetch(`${url}/rest/v1/goals?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify({ status: 'archived', notes: updatedNotes }),
  })

  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: 'Failed to archive goal', detail: err }, { status: 500 })
  }

  const updated: Goal[] = await patchRes.json()
  return NextResponse.json({ ok: true, goal: updated[0] })
}
