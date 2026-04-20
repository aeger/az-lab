'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import MonthGrid from './calendar/MonthGrid'
import EventModal, { type EventFormData, type RecurrenceFreq } from './calendar/EventModal'

// ── Types ────────────────────────────────────────────────────────────────────

interface CalendarInfo {
  id: string
  name: string
  color: string
  primary: boolean
  accessRole: string
}

interface CalendarEvent {
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
  recurringEventId?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Parse date string as local time. YYYY-MM-DD dates (all-day events from Google)
// must not be parsed with new Date() which treats them as UTC midnight, shifting
// them back a day in US timezones.
function parseLocalDate(dateStr: string): Date {
  if (dateStr.length === 10) {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(dateStr)
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatDayHeader(date: Date, today: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }
  if (isSameDay(date, today)) return 'Today'
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (isSameDay(date, tomorrow)) return 'Tomorrow'
  return date.toLocaleDateString('en-US', opts)
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function groupByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const groups = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const key = parseLocalDate(event.start).toDateString()
    const list = groups.get(key) || []
    list.push(event)
    groups.set(key, list)
  }
  return groups
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

const CAL_EVENTS_KEY = 'az_calendar_events'
const CAL_LIST_KEY   = 'az_calendar_list'

function readCacheEvents(): CalendarEvent[] {
  try { return JSON.parse(localStorage.getItem(CAL_EVENTS_KEY) || '[]') } catch { return [] }
}
function writeCacheEvents(events: CalendarEvent[]) {
  try { localStorage.setItem(CAL_EVENTS_KEY, JSON.stringify(events)) } catch {}
}
function readCacheCalendars(): CalendarInfo[] {
  try { return JSON.parse(localStorage.getItem(CAL_LIST_KEY) || '[]') } catch { return [] }
}
function writeCacheCalendars(cals: CalendarInfo[]) {
  try { localStorage.setItem(CAL_LIST_KEY, JSON.stringify(cals)) } catch {}
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CalendarWidget() {
  const cachedEvents = typeof window !== 'undefined' ? readCacheEvents() : []
  const cachedCals   = typeof window !== 'undefined' ? readCacheCalendars() : []

  const [calendars, setCalendars] = useState<CalendarInfo[]>(cachedCals)
  const [events, setEvents] = useState<CalendarEvent[]>(cachedEvents)
  const [enabledCals, setEnabledCals] = useState<Set<string>>(() => {
    if (cachedCals.length === 0) return new Set()
    try {
      const disabled: string[] = JSON.parse(localStorage.getItem('calendar-disabled') || '[]')
      return new Set(cachedCals.filter((c) => !disabled.includes(c.id)).map((c) => c.id))
    } catch { return new Set(cachedCals.map((c) => c.id)) }
  })
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [modalEvent, setModalEvent] = useState<CalendarEvent | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(cachedEvents.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [authRequired, setAuthRequired] = useState(false)
  const [showAllCalendars, setShowAllCalendars] = useState(false)

  // ── Load calendars ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/calendar/calendars')
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          setAuthRequired(true)
          setLoading(false)
          throw new Error('Unauthorized')
        }
        return r.json()
      })
      .then((data) => {
        setConfigured(data.configured !== false)
        const cals: CalendarInfo[] = data.calendars || []
        setCalendars(cals)
        writeCacheCalendars(cals)

        const stored = localStorage.getItem('calendar-disabled')
        const disabled: string[] = stored ? JSON.parse(stored) : []
        setEnabledCals(
          new Set(cals.filter((c) => !disabled.includes(c.id)).map((c) => c.id)),
        )
      })
      .catch((err) => {
        if (err.message !== 'Unauthorized') setConfigured(false)
      })
  }, [])

  // ── Fetch events ───────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async (retries = 2) => {
    if (!configured) return
    const start = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth(),
      -6,
    )
    const end = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() + 1,
      7,
    )

    setRefreshing(true)
    try {
      const res = await fetch(
        `/api/calendar?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}`,
      )
      if (res.status === 401 || res.status === 403) {
        setAuthRequired(true)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const newEvents = data.events || []
      setEvents(newEvents)
      writeCacheEvents(newEvents)
    } catch {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1500))
        return fetchEvents(retries - 1)
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [currentMonth, configured])

  useEffect(() => {
    fetchEvents()
    const interval = setInterval(fetchEvents, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchEvents])

  // ── Calendar toggles ──────────────────────────────────────────────────────

  const toggleCalendar = (calId: string) => {
    setEnabledCals((prev) => {
      const next = new Set(prev)
      if (next.has(calId)) next.delete(calId)
      else next.add(calId)
      const disabled = calendars
        .map((c) => c.id)
        .filter((id) => !next.has(id))
      localStorage.setItem('calendar-disabled', JSON.stringify(disabled))
      return next
    })
  }

  // ── Filtered events ───────────────────────────────────────────────────────

  const filteredEvents = useMemo(
    () => events.filter((e) => enabledCals.has(e.calendarId)),
    [events, enabledCals],
  )

  // ── Agenda events (from selected date or today, 14 days forward) ──────────

  const agendaEvents = useMemo(() => {
    const now = new Date()
    const start = selectedDate
      ? new Date(
          selectedDate.getFullYear(),
          selectedDate.getMonth(),
          selectedDate.getDate(),
        )
      : new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start)
    end.setDate(end.getDate() + 14)

    return filteredEvents.filter((e) => {
      const eventDate = parseLocalDate(e.start)
      return eventDate >= start && eventDate < end
    })
  }, [filteredEvents, selectedDate])

  const groupedAgenda = useMemo(() => groupByDay(agendaEvents), [agendaEvents])

  // ── Month navigation ─────────────────────────────────────────────────────

  const prevMonth = () =>
    setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))
  const nextMonth = () =>
    setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))
  const goToday = () => {
    const now = new Date()
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1))
    setSelectedDate(null)
  }

  // ── Event CRUD ────────────────────────────────────────────────────────────

  const freqToRRule = (freq: RecurrenceFreq | undefined, customDays?: string[]): string[] | undefined => {
    if (!freq || freq === 'none') return undefined
    const map: Record<string, string> = {
      daily: 'RRULE:FREQ=DAILY',
      weekly: 'RRULE:FREQ=WEEKLY',
      biweekly: 'RRULE:FREQ=WEEKLY;INTERVAL=2',
      monthly: 'RRULE:FREQ=MONTHLY',
      yearly: 'RRULE:FREQ=YEARLY',
      weekdays: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    }
    if (freq === 'custom' && customDays?.length) {
      return [`RRULE:FREQ=WEEKLY;BYDAY=${customDays.join(',')}`]
    }
    return map[freq] ? [map[freq]] : undefined
  }

  const handleCreateEvent = async (formData: EventFormData) => {
    const res = await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formData,
        recurrence: freqToRRule(formData.recurrence, formData.customDays),
      }),
    })
    if (!res.ok) throw new Error('Failed to create event')
    setShowCreate(false)
    fetchEvents()
  }

  const handleUpdateEvent = async (formData: EventFormData & { editAllEvents?: boolean }) => {
    if (!modalEvent) return

    // When editing a single instance of a recurring event, don't send recurrence
    // Google Calendar API rejects recurrence changes on individual instances
    const isEditingSingleInstance = modalEvent.recurringEventId && !formData.editAllEvents
    const recurrence = isEditingSingleInstance
      ? undefined
      : freqToRRule(formData.recurrence, formData.customDays)

    const res = await fetch(
      `/api/calendar/${encodeURIComponent(modalEvent.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          recurringEventId: modalEvent.recurringEventId,
          editAllEvents: formData.editAllEvents,
          recurrence,
        }),
      },
    )
    if (!res.ok) throw new Error('Failed to update event')
    setModalEvent(null)
    fetchEvents()
  }

  const handleDeleteEvent = async (event: CalendarEvent, allEvents?: boolean) => {
    const params = new URLSearchParams({ calendarId: event.calendarId })
    if (event.recurringEventId) {
      params.set('recurringEventId', event.recurringEventId)
    }
    if (allEvents) {
      params.set('allEvents', 'true')
    }
    const res = await fetch(
      `/api/calendar/${encodeURIComponent(event.id)}?${params}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error('Failed to delete event')
    setModalEvent(null)
    fetchEvents()
  }

  // ── Auth required state ──────────────────────────────────────────────────

  if (authRequired) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-3">&#128274;</div>
        <h3 className="text-sm font-medium text-zinc-300 mb-2">
          Sign In Required
        </h3>
        <p className="text-xs text-zinc-500">
          Sign in to view your calendar events.
        </p>
      </div>
    )
  }

  // ── Not configured state ──────────────────────────────────────────────────

  if (!configured) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-3">&#128197;</div>
        <h3 className="text-sm font-medium text-zinc-300 mb-2">
          Google Calendar Not Connected
        </h3>
        <div className="text-xs text-zinc-500 max-w-sm mx-auto space-y-1">
          <p>To set up Google Calendar integration:</p>
          <ol className="text-left list-decimal list-inside space-y-1 mt-2">
            <li>Create a Google Cloud service account</li>
            <li>Enable the Google Calendar API</li>
            <li>Share your calendars with the service account email</li>
            <li>
              Set{' '}
              <code className="text-zinc-400">GOOGLE_SERVICE_ACCOUNT_KEY</code>{' '}
              env var
            </li>
          </ol>
        </div>
      </div>
    )
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const hasWritable = calendars.some((c) =>
    ['owner', 'writer'].includes(c.accessRole),
  )

  const VISIBLE_CALS = 5
  const visibleCalendars = showAllCalendars
    ? calendars
    : calendars.slice(0, VISIBLE_CALS)
  const hiddenCount = calendars.length - VISIBLE_CALS

  const today = new Date()

  return (
    <div>
      {/* Calendar toggles + Add button */}
      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        {refreshing && <div className="w-3 h-3 border border-zinc-600 border-t-zinc-300 rounded-full animate-spin flex-shrink-0" />}
        {visibleCalendars.map((cal) => {
          const enabled = enabledCals.has(cal.id)
          return (
            <button
              key={cal.id}
              onClick={() => toggleCalendar(cal.id)}
              className={`
                flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-all
                ${
                  enabled
                    ? 'bg-zinc-800 text-zinc-200 border border-zinc-600'
                    : 'bg-zinc-900/50 text-zinc-500 border border-zinc-800'
                }
              `}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: enabled ? cal.color : '#52525b',
                }}
              />
              {cal.name}
            </button>
          )
        })}
        {hiddenCount > 0 && !showAllCalendars && (
          <button
            onClick={() => setShowAllCalendars(true)}
            className="text-xs px-2.5 py-1 rounded-full bg-zinc-900/50 text-zinc-500 border border-zinc-800 hover:text-zinc-300 transition-colors"
          >
            +{hiddenCount} more
          </button>
        )}
        {showAllCalendars && hiddenCount > 0 && (
          <button
            onClick={() => setShowAllCalendars(false)}
            className="text-xs px-2.5 py-1 rounded-full bg-zinc-900/50 text-zinc-500 border border-zinc-800 hover:text-zinc-300 transition-colors"
          >
            Show less
          </button>
        )}

        <div className="flex-1" />

        {hasWritable && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30 hover:text-blue-300 transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add Event
          </button>
        )}
      </div>

      {/* Main content: Month grid + Agenda side by side */}
      <div className="grid grid-cols-1 md:grid-cols-[360px_1fr] gap-4">
        {/* Month grid */}
        <div className="bg-zinc-800/30 rounded-xl p-4 border border-zinc-800/50">
          <MonthGrid
            currentMonth={currentMonth}
            events={filteredEvents}
            selectedDate={selectedDate}
            onSelectDate={(date) =>
              setSelectedDate(
                selectedDate && isSameDay(date, selectedDate) ? null : date,
              )
            }
            onPrevMonth={prevMonth}
            onNextMonth={nextMonth}
            onToday={goToday}
          />
        </div>

        {/* Agenda */}
        <div className="min-h-[280px] max-h-[400px] overflow-y-auto pr-1">
          {agendaEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 py-10">
              <svg
                className="w-10 h-10 mb-2 text-zinc-700"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <div className="text-sm">
                {selectedDate
                  ? 'No events on this day'
                  : 'No upcoming events'}
              </div>
              {hasWritable && (
                <button
                  onClick={() => setShowCreate(true)}
                  className="text-xs text-blue-400 hover:text-blue-300 mt-2 transition-colors"
                >
                  Create one
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {[...groupedAgenda.entries()].map(([dateKey, dayEvents]) => {
                const date = new Date(dateKey)
                const dayIsToday = isSameDay(date, today)

                return (
                  <div key={dateKey}>
                    {/* Day header */}
                    <div
                      className={`text-xs font-semibold uppercase tracking-wider mb-1.5 sticky top-0 py-1 bg-zinc-900/80 backdrop-blur-sm ${
                        dayIsToday ? 'text-blue-400' : 'text-zinc-500'
                      }`}
                    >
                      {formatDayHeader(date, today)}
                    </div>

                    {/* Events */}
                    <div className="space-y-0.5">
                      {dayEvents.map((event) => (
                        <button
                          key={`${event.calendarId}-${event.id}`}
                          onClick={() => setModalEvent(event)}
                          className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-800/60 transition-colors group"
                        >
                          {/* Color bar */}
                          <div
                            className="w-0.5 self-stretch min-h-[28px] rounded-full flex-shrink-0"
                            style={{ backgroundColor: event.calendarColor }}
                          />

                          {/* Time */}
                          <div className="w-16 flex-shrink-0 text-xs text-zinc-500 pt-0.5">
                            {event.allDay ? (
                              <span className="text-zinc-400">All day</span>
                            ) : (
                              formatTime(event.start)
                            )}
                          </div>

                          {/* Title + meta */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-zinc-200 truncate group-hover:text-zinc-100">
                              {event.title}
                            </div>
                            {event.location && (
                              <div className="text-xs text-zinc-500 truncate mt-0.5">
                                {event.location}
                              </div>
                            )}
                          </div>

                          {/* Calendar dot */}
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5 opacity-60"
                            style={{ backgroundColor: event.calendarColor }}
                            title={event.calendarName}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Event detail/edit modal */}
      {modalEvent && (
        <EventModal
          event={modalEvent}
          calendars={calendars}
          onSave={handleUpdateEvent}
          onDelete={handleDeleteEvent}
          onClose={() => setModalEvent(null)}
        />
      )}

      {/* Create event modal */}
      {showCreate && (
        <EventModal
          event={null}
          calendars={calendars}
          defaultDate={selectedDate || undefined}
          onSave={handleCreateEvent}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
