import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(req: NextRequest) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const { taskId, blockedByIds } = await req.json()

    if (!taskId || !Array.isArray(blockedByIds)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }

    const response = await fetch(`${url}/rest/v1/task_queue?id=eq.${taskId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        blocked_by_task_ids: blockedByIds.length > 0 ? blockedByIds : null,
        updated_at: new Date().toISOString(),
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Supabase error:', error)
      return NextResponse.json({ error: 'Failed to update task dependencies' }, { status: response.status })
    }

    const updated = await response.json()
    return NextResponse.json(updated[0])
  } catch (error) {
    console.error('Error updating dependencies:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
