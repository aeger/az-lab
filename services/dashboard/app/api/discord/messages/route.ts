import { NextRequest, NextResponse } from 'next/server'

async function checkAuth(req: NextRequest): Promise<boolean> {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) return false
  try {
    const authRes = await fetch('https://auth.az-lab.dev/api/state', {
      headers: { cookie },
    })
    const authData = await authRes.json()
    return authData.data?.authentication_level > 0 && !!authData.data?.username
  } catch {
    return false
  }
}

export interface DiscordMessage {
  id: string
  content: string
  author: { username: string; bot: boolean; avatar: string | null; id: string }
  timestamp: string
}

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }

  const token = process.env.DISCORD_BOT_TOKEN
  const channelId = process.env.DISCORD_CHANNEL_ID
  if (!token || !channelId) {
    return NextResponse.json({ error: 'Discord not configured' }, { status: 503 })
  }

  const { searchParams } = req.nextUrl
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100)

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
      {
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        next: { revalidate: 0 },
      }
    )

    if (!res.ok) {
      const err = await res.text()
      console.error('Discord API error:', res.status, err)
      return NextResponse.json({ error: 'Discord API error', status: res.status }, { status: 502 })
    }

    const raw: DiscordMessage[] = await res.json()
    // Discord returns newest-first; reverse to chronological order
    const messages = raw.reverse().map((m) => ({
      id: m.id,
      content: m.content,
      author: {
        username: m.author.username,
        bot: m.author.bot ?? false,
        avatar: m.author.avatar
          ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=32`
          : null,
      },
      timestamp: m.timestamp,
    }))

    return NextResponse.json({ messages, authenticated: true })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
  }
}
