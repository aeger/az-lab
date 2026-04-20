import type { Goal } from '../route'

const SELECT = 'id,parent_id,title,description,level,status,priority,target_date,completed_at,progress,tags,notes,sort_order,created_at,updated_at'

async function fetchGoalsFlat(url: string, key: string, since?: string): Promise<Goal[]> {
  let endpoint = `${url}/rest/v1/goals?select=${SELECT}&order=sort_order.asc`
  if (since) endpoint += `&updated_at=gt.${encodeURIComponent(since)}`
  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  if (!res.ok) return []
  return res.json()
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    return new Response('Supabase not configured', { status: 503 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let latestUpdatedAt: string | null = null

      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // client disconnected
        }
      }

      // Initial load — full list
      try {
        const all = await fetchGoalsFlat(supabaseUrl, supabaseKey)
        if (all.length > 0) {
          latestUpdatedAt = all.reduce((max, g) => g.updated_at > max ? g.updated_at : max, all[0].updated_at)
          send({ goals: all, type: 'init' })
        } else {
          send({ goals: [], type: 'init' })
        }
      } catch {
        send({ goals: [], type: 'init' })
      }

      // Poll every 5s for changes
      const interval = setInterval(async () => {
        if (!latestUpdatedAt) return
        try {
          const changed = await fetchGoalsFlat(supabaseUrl, supabaseKey, latestUpdatedAt)
          if (changed.length > 0) {
            latestUpdatedAt = changed.reduce((max, g) => g.updated_at > max ? g.updated_at : max, changed[0].updated_at)
            send({ goals: changed, type: 'delta' })
          }
        } catch {
          // ignore transient errors
        }
      }, 5000)

      // Keepalive every 20s
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          clearInterval(keepalive)
          clearInterval(interval)
        }
      }, 20000)

      req.signal.addEventListener('abort', () => {
        clearInterval(interval)
        clearInterval(keepalive)
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
