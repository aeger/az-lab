import { NextRequest, NextResponse } from 'next/server'
import {
  listCalendars,
  listEvents,
  createEvent,
  isConfigured,
  type CalendarInfo,
} from '@/lib/google-calendar'

export async function GET(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isConfigured()) {
    return NextResponse.json({ events: [], configured: false })
  }

  try {
    const { searchParams } = req.nextUrl
    const timeMin =
      searchParams.get('timeMin') || new Date().toISOString()
    const timeMax =
      searchParams.get('timeMax') ||
      new Date(Date.now() + 30 * 86400000).toISOString()
    const calendarIdsParam = searchParams.get('calendarIds')

    const calendars = await listCalendars()
    const calendarsMap = new Map<string, CalendarInfo>()
    for (const cal of calendars) calendarsMap.set(cal.id, cal)

    const calendarIds = calendarIdsParam
      ? calendarIdsParam.split(',')
      : calendars.map((c) => c.id)

    const events = await listEvents(calendarIds, timeMin, timeMax, calendarsMap)
    return NextResponse.json({ events, configured: true })
  } catch (error) {
    console.error('Calendar events error:', error)
    return NextResponse.json(
      { events: [], error: 'Failed to fetch events', configured: true },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isConfigured()) {
    return NextResponse.json(
      { error: 'Calendar not configured' },
      { status: 503 },
    )
  }

  try {
    const body = await req.json()
    const { calendarId, title, description, location, start, end, allDay, recurrence } =
      body

    if (!calendarId || !title || !start || !end) {
      return NextResponse.json(
        { error: 'Missing required fields: calendarId, title, start, end' },
        { status: 400 },
      )
    }

    const event = await createEvent({
      calendarId,
      title,
      description,
      location,
      start,
      end,
      allDay: !!allDay,
      recurrence,
    })
    return NextResponse.json({ event })
  } catch (error) {
    console.error('Create event error:', error)
    return NextResponse.json(
      { error: 'Failed to create event' },
      { status: 500 },
    )
  }
}
