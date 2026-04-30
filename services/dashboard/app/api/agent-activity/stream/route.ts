import type { ActivityRow } from '../route'

async function fetchSince(url: string, key: string, agent: string, since: string | null, limit: number): Promise<ActivityRow[]> {
  let endpoint = `${url}/rest/v1/agent_activity?select=id,agent,session_id,task_id,activity_type,content,metadata,created_at&agent=eq.${agent}&order=created_at.asc&limit=${limit}`
  if (since) endpoint += `&created_at=gt.${encodeURIComponent(since)}`
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

  const { searchParams } = new URL(req.url)
  const agent = searchParams.get('agent') ?? 'wren'

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let since: string | null = null

      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // client disconnected
        }
      }

      // Initial load — last 60 rows
      try {
        const initial = await fetchSince(supabaseUrl, supabaseKey, agent, null, 60)
        // For initial load we query desc then reverse — use a separate query
        const initEndpoint = `${supabaseUrl}/rest/v1/agent_activity?select=id,agent,session_id,task_id,activity_type,content,metadata,created_at&agent=eq.${agent}&order=created_at.desc&limit=60`
        const initRes = await fetch(initEndpoint, {
          headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          cache: 'no-store',
        })
        const initRows: ActivityRow[] = initRes.ok ? (await initRes.json()).reverse() : initial
        if (initRows.length > 0) {
          since = initRows[initRows.length - 1].created_at
          send({ rows: initRows, type: 'init' })
        }
      } catch {
        send({ rows: [], type: 'init' })
      }

      // Poll every 1s for new rows
      const interval = setInterval(async () => {
        try {
          const rows = await fetchSince(supabaseUrl, supabaseKey, agent, since, 20)
          if (rows.length > 0) {
            since = rows[rows.length - 1].created_at
            send({ rows, type: 'delta' })
          }
        } catch {
          // ignore transient errors
        }
      }, 1000)

      // Keepalive every 15s
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          clearInterval(keepalive)
          clearInterval(interval)
        }
      }, 15000)

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
