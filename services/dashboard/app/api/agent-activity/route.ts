import { NextResponse } from 'next/server'

export interface ActivityRow {
  id: string
  agent: string
  session_id: string | null
  task_id: string | null
  activity_type: 'thinking' | 'tool_call' | 'result' | 'status' | 'error' | 'progress'
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export async function GET(req: Request) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const agent = searchParams.get('agent') ?? 'wren'
  const since = searchParams.get('since') // ISO timestamp for polling
  const taskId = searchParams.get('task_id')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)

  let endpoint = `${url}/rest/v1/agent_activity?select=id,agent,session_id,task_id,activity_type,content,metadata,created_at&agent=eq.${agent}&order=created_at.desc&limit=${limit}`
  if (since) endpoint += `&created_at=gt.${encodeURIComponent(since)}`
  if (taskId) endpoint += `&task_id=eq.${encodeURIComponent(taskId)}`

  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      next: { revalidate: 4 },
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
    const rows: ActivityRow[] = await res.json()
    // Return in chronological order (reversed from DESC query)
    return NextResponse.json({ rows: rows.reverse() })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
  }
}
