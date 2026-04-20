// Dashboard API — Sound Preferences
// GET  /api/sound-preferences       → load from Supabase user_preferences
// POST /api/sound-preferences       → save to Supabase user_preferences
//
// Falls back gracefully if user_preferences table doesn't exist yet.
// To apply the table migration: run migrations/016_user_preferences.sql

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const USER_ID = 'jeff'
const PREF_KEY = 'sound_settings'

function supabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY!,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    Prefer: 'return=representation',
  }
}

async function getPreference(): Promise<Record<string, unknown> | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${USER_ID}&key=eq.${PREF_KEY}&select=value`,
      { headers: supabaseHeaders(), cache: 'no-store' },
    )
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0]?.value ?? null
  } catch {
    return null
  }
}

async function upsertPreference(value: Record<string, unknown>): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences`,
      {
        method: 'POST',
        headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: USER_ID, key: PREF_KEY, value }),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

export async function GET() {
  const prefs = await getPreference()
  if (!prefs) {
    return NextResponse.json({ ok: false, message: 'user_preferences table not found or Supabase unavailable' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, settings: prefs })
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON' }, { status: 400 })
  }

  const settings = body.settings as Record<string, unknown>
  if (!settings || typeof settings !== 'object') {
    return NextResponse.json({ ok: false, message: 'Missing settings field' }, { status: 400 })
  }

  const ok = await upsertPreference(settings)
  if (!ok) {
    return NextResponse.json({ ok: false, message: 'Supabase unavailable or table not created yet' }, { status: 503 })
  }

  return NextResponse.json({ ok: true })
}
