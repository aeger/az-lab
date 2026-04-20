import { NextRequest, NextResponse } from 'next/server'

// Minimal iCal parser — extracts VEVENT blocks filtered to timeMin..timeMax
function parseIcal(text: string, timeMin: Date, timeMax: Date) {
  const events: {
    id: string; title: string; start: string; end: string; allDay: boolean
  }[] = []

  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)
  let inEvent = false
  let cur: Record<string, string> = {}

  const parseDate = (s: string): Date | null => {
    if (!s) return null
    if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`)
    if (/^\d{8}T\d{6}Z$/.test(s)) return new Date(s.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'))
    const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/)
    return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue }
    if (line === 'END:VEVENT') {
      inEvent = false
      const dtstart = cur['DTSTART'] || cur['DTSTART;VALUE=DATE'] || ''
      const dtend = cur['DTEND'] || cur['DTEND;VALUE=DATE'] || ''
      const allDay = /^\d{8}$/.test(dtstart)
      const start = parseDate(dtstart)
      const end = parseDate(dtend)
      if (start && !isNaN(start.getTime()) && start >= timeMin && start <= timeMax) {
        events.push({
          id: cur['UID'] || `${start.getTime()}`,
          title: cur['SUMMARY'] || '(No title)',
          start: start.toISOString(),
          end: (end && !isNaN(end.getTime())) ? end.toISOString() : start.toISOString(),
          allDay,
        })
      }
      continue
    }
    if (!inEvent) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const keyFull = line.slice(0, colon)
    const key = keyFull.split(';')[0]
    cur[keyFull] = line.slice(colon + 1)
    if (keyFull !== key) cur[key] = line.slice(colon + 1)
  }

  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  return events
}

export async function GET(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const icalUrl = process.env.GOOGLE_CALENDAR_ICAL_URL
  if (!icalUrl) {
    return NextResponse.json({ events: [], configured: false })
  }

  try {
    const { searchParams } = req.nextUrl
    const timeMin = new Date(searchParams.get('timeMin') || new Date().toISOString())
    const timeMax = new Date(searchParams.get('timeMax') || new Date(Date.now() + 30 * 86400000).toISOString())

    const urls = icalUrl.split(',').map(s => s.trim()).filter(Boolean)
    const results = await Promise.allSettled(urls.map(url => fetch(url).then(r => r.text())))

    const allEvents: ReturnType<typeof parseIcal> = []
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      allEvents.push(...parseIcal(result.value, timeMin, timeMax))
    }
    allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    return NextResponse.json({ events: allEvents, configured: true })
  } catch (error) {
    console.error('iCal fetch error:', error)
    return NextResponse.json({ events: [], error: 'Failed to fetch calendar', configured: true }, { status: 500 })
  }
}
