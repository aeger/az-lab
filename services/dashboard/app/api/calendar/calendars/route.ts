import { NextResponse } from 'next/server'
import { listCalendars, isConfigured } from '@/lib/google-calendar'

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isConfigured()) {
    return NextResponse.json({ calendars: [], configured: false })
  }

  try {
    const calendars = await listCalendars()
    return NextResponse.json({ calendars, configured: true })
  } catch (error) {
    console.error('List calendars error:', error)
    return NextResponse.json(
      { calendars: [], error: 'Failed to list calendars', configured: true },
      { status: 500 },
    )
  }
}
