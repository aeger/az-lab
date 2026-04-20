import { NextRequest, NextResponse } from 'next/server'
import { updateEvent, deleteEvent, isConfigured } from '@/lib/google-calendar'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
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
    const { eventId } = await params
    const body = await req.json()
    const {
      calendarId,
      title,
      description,
      location,
      start,
      end,
      allDay,
      recurringEventId,
      editAllEvents,
      recurrence,
    } = body

    if (!calendarId) {
      return NextResponse.json(
        { error: 'calendarId is required' },
        { status: 400 },
      )
    }

    // If editing all recurring instances, use the parent event ID
    const targetId =
      editAllEvents && recurringEventId ? recurringEventId : eventId

    const event = await updateEvent(targetId, {
      calendarId,
      title,
      description,
      location,
      start,
      end,
      allDay,
      recurrence,
    })
    return NextResponse.json({ event })
  } catch (error) {
    console.error('Update event error:', error)
    return NextResponse.json(
      { error: 'Failed to update event' },
      { status: 500 },
    )
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
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
    const { eventId } = await params
    const calendarId = req.nextUrl.searchParams.get('calendarId')
    const recurringEventId = req.nextUrl.searchParams.get('recurringEventId')
    const allEvents = req.nextUrl.searchParams.get('allEvents') === 'true'

    if (!calendarId) {
      return NextResponse.json(
        { error: 'calendarId query param is required' },
        { status: 400 },
      )
    }

    // If deleting all recurring instances, delete the parent event
    const targetId =
      allEvents && recurringEventId ? recurringEventId : eventId

    await deleteEvent(calendarId, targetId)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete event error:', error)
    return NextResponse.json(
      { error: 'Failed to delete event' },
      { status: 500 },
    )
  }
}
