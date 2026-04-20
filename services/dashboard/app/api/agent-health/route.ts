import { NextResponse } from 'next/server'

interface AgentHeartbeat {
  agent: string
  status: string
  last_heartbeat: string | null
  prompt_count: number
  last_restart: string | null
  restart_count_hour: number
  breaker_tripped: boolean
  metadata: Record<string, unknown>
  updated_at: string
}

export async function GET() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY

  if (!url || !key) {
    return NextResponse.json({ agents: [] })
  }

  try {
    const res = await fetch(`${url}/rest/v1/agent_heartbeat?select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      next: { revalidate: 0 },
    })

    if (!res.ok) throw new Error(`Supabase ${res.status}`)
    const agents = (await res.json()) as AgentHeartbeat[]

    return NextResponse.json({ agents })
  } catch {
    return NextResponse.json({ agents: [] })
  }
}
