import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  let body: { url?: unknown; title?: unknown; excerpt?: unknown; source?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const excerpt = typeof body.excerpt === 'string' ? body.excerpt.trim() : ''
  const source = typeof body.source === 'string' ? body.source.trim() : ''

  if (!url || !title) {
    return NextResponse.json({ error: 'url and title are required' }, { status: 400 })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  const description = [source && `Source: ${source}`, url, excerpt && `\n${excerpt}`]
    .filter(Boolean)
    .join('\n')

  const payload = {
    title: `Read later: ${title}`.slice(0, 200),
    description: description.slice(0, 1000),
    status: 'pending',
    source: 'dashboard-news',
    target: 'wren',
    priority: 3,
    tags: ['saved-article'],
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/task_queue`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `Supabase error: ${text}` }, { status: 502 })
    }

    const data = await res.json()
    return NextResponse.json({ ok: true, id: data[0]?.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
}
