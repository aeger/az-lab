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

  // Extract pre-archive status from notes sentinel
  const notes = goal.notes ?? ''
  const match = notes.match(/^\[archived:(\w+):.*?\]/)
  const restoreStatus = match?.[1] ?? 'active'
  const cleanedNotes = notes.replace(/^\[archived:.*?\]\n?/, '')

  const patchRes = await fetch(`${url}/rest/v1/goals?id=eq.${id}`, {
    method: 'PATCH',
    headers: SUPA_HEADERS(key),
    body: JSON.stringify({ status: restoreStatus, notes: cleanedNotes || null }),
  })

  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: 'Failed to restore goal', detail: err }, { status: 500 })
  }

  const updated: Goal[] = await patchRes.json()
  return NextResponse.json({ ok: true, goal: updated[0], restoredTo: restoreStatus })
}
