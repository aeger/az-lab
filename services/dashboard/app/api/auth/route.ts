import { NextRequest, NextResponse } from 'next/server'

const AUTHELIA_STATE_URL = 'https://auth.az-lab.dev/api/state'

export async function GET(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''

  try {
    const res = await fetch(AUTHELIA_STATE_URL, {
      headers: { cookie },
    })
    const data = await res.json()

    if (data.data?.authentication_level > 0 && data.data?.username) {
      return NextResponse.json({ authenticated: true, user: data.data.username })
    }
    return NextResponse.json({ authenticated: false })
  } catch {
    return NextResponse.json({ authenticated: false })
  }
}
