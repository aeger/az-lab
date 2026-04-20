import { NextRequest, NextResponse } from 'next/server'
import type { TaskItem } from '@/app/api/taskqueue/route'

const SELECT = 'id,title,description,status,priority,source,target,claimed_by,claimed_at,created_at,updated_at,tags,result,error,blocked_reason,failure_mode,attempt_count,goal_id,context'

export async function GET(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const search = req.nextUrl.searchParams.get('search') ?? ''
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50'), 200)

  let endpoint = `${url}/rest/v1/task_queue?select=${SELECT}&status=eq.archived&order=updated_at.desc&limit=${limit}`

  if (search) {
    // PostgREST ilike filter on title
    endpoint += `&title=ilike.*${encodeURIComponent(search)}*`
  }

  try {
    const res = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: 'no-store',
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch archived tasks' }, { status: 500 })
    const tasks: TaskItem[] = await res.json()
    return NextResponse.json({ tasks })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch archived tasks' }, { status: 500 })
  }
}
