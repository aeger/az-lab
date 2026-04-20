import { JWT } from 'google-auth-library'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

let _client: JWT | null = null
let _subscribed = false

function getClient(): JWT {
  if (_client) return _client

  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyEnv) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set')

  let credentials: { client_email: string; private_key: string }
  try {
    credentials = JSON.parse(keyEnv)
  } catch {
    credentials = JSON.parse(Buffer.from(keyEnv, 'base64').toString())
  }

  _client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  })

  return _client
}

async function getToken(): Promise<string> {
  const client = getClient()
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('Failed to get access token')
  return token
}

async function apiGet(path: string, params?: Record<string, string>) {
  const token = await getToken()
  const url = new URL(`${CALENDAR_API}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`)
  return res.json()
}

async function apiPost(path: string, body: unknown) {
  const token = await getToken()
  const res = await fetch(`${CALENDAR_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`)
  return res.json()
}

async function apiPatch(path: string, body: unknown) {
  const token = await getToken()
  const res = await fetch(`${CALENDAR_API}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`)
  return res.json()
}

async function apiDelete(path: string) {
  const token = await getToken()
  const res = await fetch(`${CALENDAR_API}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`Calendar API ${res.status}: ${await res.text()}`)
  }
}

// ── Public Types ─────────────────────────────────────────────────────────────

export interface CalendarInfo {
  id: string
  name: string
  color: string
  primary: boolean
  accessRole: string // owner | writer | reader | freeBusyReader
}

export interface CalendarEvent {
  id: string
  calendarId: string
  calendarName: string
  calendarColor: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay: boolean
  htmlLink?: string
  status: string
  editable: boolean
  recurringEventId?: string // present if this is an instance of a recurring event
}

export interface EventInput {
  calendarId: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay: boolean
  recurrence?: string[] // e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
}

// ── Calendar Color Overrides ─────────────────────────────────────────────────

const COLOR_OVERRIDES: Record<string, string> = {
  Jeff: '#3B82F6',           // bright blue
  Heather: '#A855F7',       // bright purple
  Family: '#F97316',         // bright orange
  'Christian Holidays': '#E4E4E7',  // white/light
  'Holidays in Israel': '#E4E4E7',  // white/light
}

// ── Public Functions ─────────────────────────────────────────────────────────

export function isConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  // Service accounts don't auto-accept calendar shares.
  // Subscribe to calendars listed in GOOGLE_CALENDAR_IDS on first call.
  if (!_subscribed) {
    _subscribed = true
    const calIds = process.env.GOOGLE_CALENDAR_IDS
    if (calIds) {
      const ids = calIds.split(',').map((s) => s.trim()).filter(Boolean)
      const existing = await apiGet('/users/me/calendarList')
      const existingIds = new Set(
        ((existing.items || []) as Record<string, unknown>[]).map(
          (c) => c.id as string,
        ),
      )
      for (const id of ids) {
        if (existingIds.has(id)) continue
        try {
          await apiPost('/users/me/calendarList', { id })
        } catch (e) {
          console.warn(`Failed to subscribe to calendar ${id}:`, e)
        }
      }
    }
  }

  const data = await apiGet('/users/me/calendarList')
  return (data.items || []).map((cal: Record<string, unknown>) => {
    const name = (cal.summaryOverride || cal.summary || cal.id) as string
    return {
      id: cal.id as string,
      name,
      color: COLOR_OVERRIDES[name] || (cal.backgroundColor as string) || '#4285F4',
      primary: (cal.primary || false) as boolean,
      accessRole: (cal.accessRole || 'reader') as string,
    }
  })
}

export async function listEvents(
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  calendarsMap: Map<string, CalendarInfo>,
): Promise<CalendarEvent[]> {
  const results = await Promise.allSettled(
    calendarIds.map(async (calId) => {
      const data = await apiGet(
        `/calendars/${encodeURIComponent(calId)}/events`,
        {
          timeMin,
          timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '250',
        },
      )
      return { calId, items: (data.items || []) as Record<string, unknown>[] }
    }),
  )

  const events: CalendarEvent[] = []

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const { calId, items } = result.value
    const calInfo = calendarsMap.get(calId)

    for (const item of items) {
      if (item.status === 'cancelled') continue
      const startObj = item.start as Record<string, string> | undefined
      const endObj = item.end as Record<string, string> | undefined
      if (!startObj) continue

      const allDay = !!startObj.date
      events.push({
        id: item.id as string,
        calendarId: calId,
        calendarName: calInfo?.name || calId,
        calendarColor: calInfo?.color || '#4285F4',
        title: (item.summary as string) || '(No title)',
        description: item.description as string | undefined,
        location: item.location as string | undefined,
        start: allDay ? startObj.date : startObj.dateTime,
        end: allDay
          ? (endObj?.date ?? startObj.date)
          : (endObj?.dateTime ?? startObj.dateTime),
        allDay,
        htmlLink: item.htmlLink as string | undefined,
        status: item.status as string,
        editable: calInfo
          ? ['owner', 'writer'].includes(calInfo.accessRole)
          : false,
        recurringEventId: item.recurringEventId as string | undefined,
      })
    }
  }

  events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  )
  return events
}

export async function createEvent(input: EventInput): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {
    summary: input.title,
    description: input.description || undefined,
    location: input.location || undefined,
  }

  if (input.allDay) {
    body.start = { date: input.start }
    body.end = { date: input.end }
  } else {
    body.start = { dateTime: input.start }
    body.end = { dateTime: input.end }
  }

  if (input.recurrence?.length) {
    body.recurrence = input.recurrence
  }

  const data = await apiPost(
    `/calendars/${encodeURIComponent(input.calendarId)}/events`,
    body,
  )

  const startObj = data.start as Record<string, string>
  const endObj = data.end as Record<string, string>
  const allDay = !!startObj.date

  return {
    id: data.id,
    calendarId: input.calendarId,
    calendarName: '',
    calendarColor: '',
    title: data.summary || input.title,
    description: data.description,
    location: data.location,
    start: allDay ? startObj.date : startObj.dateTime,
    end: allDay ? endObj.date : endObj.dateTime,
    allDay,
    htmlLink: data.htmlLink,
    status: data.status,
    editable: true,
  }
}

export async function updateEvent(
  eventId: string,
  input: Partial<EventInput> & { calendarId: string },
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {}
  if (input.title !== undefined) body.summary = input.title
  if (input.description !== undefined) body.description = input.description
  if (input.location !== undefined) body.location = input.location

  if (input.start !== undefined || input.end !== undefined) {
    const allDay = input.allDay ?? false
    if (allDay) {
      if (input.start) body.start = { date: input.start }
      if (input.end) body.end = { date: input.end }
    } else {
      if (input.start) body.start = { dateTime: input.start }
      if (input.end) body.end = { dateTime: input.end }
    }
  }

  if (input.recurrence !== undefined) {
    body.recurrence = input.recurrence.length ? input.recurrence : []
  }

  const data = await apiPatch(
    `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(eventId)}`,
    body,
  )

  const startObj = data.start as Record<string, string>
  const endObj = data.end as Record<string, string>
  const allDay = !!startObj.date

  return {
    id: data.id,
    calendarId: input.calendarId,
    calendarName: '',
    calendarColor: '',
    title: data.summary,
    description: data.description,
    location: data.location,
    start: allDay ? startObj.date : startObj.dateTime,
    end: allDay ? endObj.date : endObj.dateTime,
    allDay,
    htmlLink: data.htmlLink,
    status: data.status,
    editable: true,
  }
}

export async function deleteEvent(
  calendarId: string,
  eventId: string,
): Promise<void> {
  await apiDelete(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  )
}
