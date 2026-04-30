import { NextResponse } from 'next/server'
import type { Goal } from '@/app/api/goals/route'

const SELECT = 'id,parent_id,title,description,level,status,priority,target_date,completed_at,progress,tags,notes,sort_order,created_at,updated_at'

export async function GET() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const res = await fetch(
      `${url}/rest/v1/goals?select=${SELECT}&status=eq.archived&order=updated_at.desc&limit=100`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' }
    )
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch archived goals' }, { status: 500 })
    const goals: Goal[] = await res.json()
    return NextResponse.json({ goals })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch archived goals' }, { status: 500 })
  }
}
