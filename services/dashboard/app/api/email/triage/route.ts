import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }

    const body = JSON.stringify({
      title: 'Run email triage now',
      description: 'Manual trigger from dashboard. Run the hourly-email-triage task immediately: check inbox, archive junk, surface important items, and post a summary to Discord.',
      status: 'pending',
      target: 'iris',
      priority: 2,
      source: 'dashboard',
      tags: ['email-triage', 'manual-trigger'],
      context: { trigger_id: 'hourly-email-triage', triggered_at: new Date().toISOString() },
    })

    const res = await fetch(`${url}/rest/v1/task_queue`, {
      method: 'POST',
      headers,
      body,
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: `Queue insert failed: ${err}` }, { status: 500 })
    }

    const [created] = await res.json()
    return NextResponse.json({ success: true, taskId: created?.id, queuedAt: new Date().toISOString() })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
