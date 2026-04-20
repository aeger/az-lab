import { NextRequest, NextResponse } from 'next/server'

async function checkAuth(req: NextRequest): Promise<string | null> {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) return null
  try {
    const authRes = await fetch('https://auth.az-lab.dev/api/state', {
      headers: { cookie },
    })
    const authData = await authRes.json()
    if (authData.data?.authentication_level > 0 && authData.data?.username) {
      return authData.data.username as string
    }
    return null
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const username = await checkAuth(req)
  if (!username) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }

  const token = process.env.DISCORD_BOT_TOKEN
  const channelId = process.env.DISCORD_CHANNEL_ID
  if (!token || !channelId) {
    return NextResponse.json({ error: 'Discord not configured' }, { status: 503 })
  }

  let content: string
  try {
    const body = await req.json()
    content = (body.content ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!content) {
    return NextResponse.json({ error: 'Message content required' }, { status: 400 })
  }
  if (content.length > 2000) {
    return NextResponse.json({ error: 'Message too long (max 2000 chars)' }, { status: 400 })
  }

  // Prefix with dashboard username so origin is clear in Discord
  const payload = { content: `**[${username}]** ${content}` }

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )

    if (!res.ok) {
      const err = await res.text()
      console.error('Discord send error:', res.status, err)
      return NextResponse.json({ error: 'Discord API error', status: res.status }, { status: 502 })
    }

    const message = await res.json()
    return NextResponse.json({ ok: true, id: message.id })
  } catch {
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}
