'use client'

import { useState, useEffect } from 'react'

interface CalendarInfo {
  id: string
  name: string
  color: string
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

interface EventModalProps {
  event: CalendarEvent | null // null = create mode
  calendars: CalendarInfo[]
  defaultDate?: Date
  defaultCalendarId?: string
  onSave: (data: EventFormData & { editAllEvents?: boolean }) => Promise<void>
  onDelete?: (event: CalendarEvent, allEvents?: boolean) => Promise<void>
  onClose: () => void
}

export type RecurrenceFreq = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'weekdays' | 'custom'

export interface EventFormData {
  calendarId: string
  title: string
  description: string
  location: string
  start: string
  end: string
  allDay: boolean
  editAllEvents?: boolean
  recurrence?: RecurrenceFreq
  customDays?: string[]
}

function toLocalDate(iso: string): string {
  if (iso.length === 10) return iso // already YYYY-MM-DD
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toLocalTime(iso: string): string {
  if (iso.length === 10) return '09:00'
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function EventModal({
  event,
  calendars,
  defaultDate,
  defaultCalendarId,
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const isCreate = !event
  const isEditable = isCreate || event.editable

  const writableCalendars = calendars.filter((c) =>
    ['owner', 'writer'].includes(c.accessRole),
  )

  const defaultDateStr = defaultDate
    ? `${defaultDate.getFullYear()}-${String(defaultDate.getMonth() + 1).padStart(2, '0')}-${String(defaultDate.getDate()).padStart(2, '0')}`
    : new Date().toISOString().slice(0, 10)

  const [form, setForm] = useState<EventFormData>(() => {
    if (event) {
      return {
        calendarId: event.calendarId,
        title: event.title,
        description: event.description || '',
        location: event.location || '',
        start: toLocalDate(event.start),
        end: toLocalDate(event.end),
        allDay: event.allDay,
        recurrence: 'none' as RecurrenceFreq,
      }
    }
    return {
      calendarId:
        defaultCalendarId || writableCalendars[0]?.id || '',
      title: '',
      description: '',
      location: '',
      start: defaultDateStr,
      end: defaultDateStr,
      allDay: true,
      recurrence: 'none' as RecurrenceFreq,
    }
  })

  const [startTime, setStartTime] = useState(() =>
    event && !event.allDay ? toLocalTime(event.start) : '09:00',
  )
  const [endTime, setEndTime] = useState(() =>
    event && !event.allDay ? toLocalTime(event.end) : '10:00',
  )

  const [editing, setEditing] = useState(isCreate)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSave = async (editAllEvents?: boolean) => {
    if (!form.title.trim()) {
      setError('Title is required')
      return
    }
    if (!form.calendarId) {
      setError('Select a calendar')
      return
    }

    setSaving(true)
    setError('')

    try {
      let startISO: string
      let endISO: string

      if (form.allDay) {
        startISO = form.start
        // Google Calendar all-day end is exclusive, so add 1 day if same as start
        const endDate = form.end || form.start
        if (endDate <= form.start) {
          const d = new Date(form.start)
          d.setDate(d.getDate() + 1)
          endISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        } else {
          endISO = endDate
        }
      } else {
        startISO = new Date(`${form.start}T${startTime}`).toISOString()
        endISO = new Date(`${form.end || form.start}T${endTime}`).toISOString()
      }

      await onSave({
        ...form,
        title: form.title.trim(),
        start: startISO,
        end: endISO,
        editAllEvents,
      })
    } catch {
      setError('Failed to save event')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (allEvents?: boolean) => {
    if (!event || !onDelete) return
    setSaving(true)
    try {
      await onDelete(event, allEvents)
    } catch {
      setError('Failed to delete event')
      setSaving(false)
    }
  }

  const isRecurring = !!event?.recurringEventId

  const calColor =
    calendars.find((c) => c.id === (event?.calendarId || form.calendarId))
      ?.color || '#4285F4'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: calColor }}
            />
            <h2 className="text-base font-semibold text-zinc-100">
              {isCreate ? 'New Event' : editing ? 'Edit Event' : event.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-1"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 pb-5">
          {/* View mode */}
          {!editing && event && (
            <div className="space-y-3 mt-2">
              <div>
                <div className="text-xs text-zinc-500 mb-0.5">When</div>
                <div className="text-sm text-zinc-300">
                  {event.allDay
                    ? formatDateRange(event.start, event.end, true)
                    : formatDateRange(event.start, event.end, false)}
                </div>
              </div>
              {event.location && (
                <div>
                  <div className="text-xs text-zinc-500 mb-0.5">Where</div>
                  <div className="text-sm text-zinc-300">{event.location}</div>
                </div>
              )}
              {event.description && (
                <div>
                  <div className="text-xs text-zinc-500 mb-0.5">Notes</div>
                  <div className="text-sm text-zinc-400 whitespace-pre-wrap">
                    {event.description}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-4">
                <div>
                  <div className="text-xs text-zinc-500 mb-0.5">Calendar</div>
                  <div className="flex items-center gap-1.5 text-sm text-zinc-300">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: event.calendarColor }}
                    />
                    {event.calendarName}
                  </div>
                </div>
                {isRecurring && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-0.5">Type</div>
                    <div className="text-sm text-zinc-400">Recurring</div>
                  </div>
                )}
              </div>

              {event.editable && (
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setEditing(true)}
                    className="flex-1 text-sm py-2 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
                  >
                    Edit
                  </button>
                  {event.htmlLink && (
                    <a
                      href={event.htmlLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm py-2 px-4 rounded-lg bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                    >
                      Open in Google
                    </a>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Edit / Create mode */}
          {editing && (
            <div className="space-y-3 mt-2">
              {/* Title */}
              <input
                type="text"
                placeholder="Event title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                autoFocus
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              {/* Calendar picker */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">
                  Calendar
                </label>
                <select
                  value={form.calendarId}
                  onChange={(e) =>
                    setForm({ ...form, calendarId: e.target.value })
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {writableCalendars.map((cal) => (
                    <option key={cal.id} value={cal.id}>
                      {cal.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* All day toggle */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(e) =>
                    setForm({ ...form, allDay: e.target.checked })
                  }
                  className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-300">All day</span>
              </label>

              {/* Date & Time */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">
                    Start
                  </label>
                  <input
                    type="date"
                    value={form.start}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        start: e.target.value,
                        end: form.end < e.target.value ? e.target.value : form.end,
                      })
                    }
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">
                    End
                  </label>
                  <input
                    type="date"
                    value={form.end || form.start}
                    onChange={(e) =>
                      setForm({ ...form, end: e.target.value })
                    }
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {!form.allDay && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">
                      Start time
                    </label>
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">
                      End time
                    </label>
                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>
              )}

              {/* Recurrence — show on create, or when editing all events of a series */}
              {(isCreate || (isRecurring && form.editAllEvents !== false)) && (
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">
                    Repeat
                  </label>
                  <select
                    value={form.recurrence || 'none'}
                    onChange={(e) =>
                      setForm({ ...form, recurrence: e.target.value as RecurrenceFreq })
                    }
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="none">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every 2 weeks</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                    <option value="weekdays">Weekdays (Mon-Fri)</option>
                    <option value="custom">Custom days of week...</option>
                  </select>
                  {form.recurrence === 'custom' && (
                    <div className="flex gap-1.5 mt-2 flex-wrap">
                      {(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const).map((day) => {
                        const labels: Record<string, string> = { SU: 'Su', MO: 'Mo', TU: 'Tu', WE: 'We', TH: 'Th', FR: 'Fr', SA: 'Sa' }
                        const selected = (form.customDays || []).includes(day)
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => {
                              const days = form.customDays || []
                              const next = selected ? days.filter((d) => d !== day) : [...days, day]
                              setForm({ ...form, customDays: next })
                            }}
                            className={`w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                              selected
                                ? 'bg-blue-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500'
                            }`}
                          >
                            {labels[day]}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Location */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">
                  Location
                </label>
                <input
                  type="text"
                  placeholder="Add location"
                  value={form.location}
                  onChange={(e) =>
                    setForm({ ...form, location: e.target.value })
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">
                  Notes
                </label>
                <textarea
                  placeholder="Add notes"
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  rows={2}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                />
              </div>

              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-1 flex-wrap">
                {!isCreate && isRecurring ? (
                  <>
                    <button
                      onClick={() => handleSave(false)}
                      disabled={saving}
                      className="flex-1 text-sm py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors font-medium"
                    >
                      {saving ? 'Saving...' : 'Save This Event'}
                    </button>
                    <button
                      onClick={() => handleSave(true)}
                      disabled={saving}
                      className="flex-1 text-sm py-2 rounded-lg bg-blue-600/60 text-blue-100 hover:bg-blue-600/80 disabled:opacity-50 transition-colors font-medium"
                    >
                      {saving ? 'Saving...' : 'Save All Events'}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => handleSave()}
                    disabled={saving}
                    className="flex-1 text-sm py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors font-medium"
                  >
                    {saving ? 'Saving...' : isCreate ? 'Create Event' : 'Save Changes'}
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="text-sm py-2 px-4 rounded-lg bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
              </div>

              {/* Delete */}
              {!isCreate && event?.editable && onDelete && (
                <div className="pt-2 border-t border-zinc-800">
                  {confirmDelete ? (
                    <div className="space-y-2">
                      <span className="text-sm text-red-400 block">
                        {isRecurring
                          ? 'Delete this recurring event?'
                          : 'Delete this event?'}
                      </span>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => handleDelete(false)}
                          disabled={saving}
                          className="text-sm py-1 px-3 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
                        >
                          {saving
                            ? 'Deleting...'
                            : isRecurring
                              ? 'This event only'
                              : 'Yes, delete'}
                        </button>
                        {isRecurring && (
                          <button
                            onClick={() => handleDelete(true)}
                            disabled={saving}
                            className="text-sm py-1 px-3 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
                          >
                            {saving ? 'Deleting...' : 'All events in series'}
                          </button>
                        )}
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="text-sm py-1 px-3 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="text-sm text-red-500/70 hover:text-red-400 transition-colors"
                    >
                      Delete event
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function parseLocal(dateStr: string): Date {
  if (dateStr.length === 10) {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(dateStr)
}

function formatDateRange(start: string, end: string, allDay: boolean): string {
  const s = parseLocal(start)
  const e = parseLocal(end)
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }

  if (allDay) {
    const sStr = s.toLocaleDateString('en-US', dateOpts)
    // For all-day events, Google end date is exclusive
    const eAdj = new Date(e)
    eAdj.setDate(eAdj.getDate() - 1)
    if (s.toDateString() === eAdj.toDateString()) return sStr
    return `${sStr} - ${eAdj.toLocaleDateString('en-US', dateOpts)}`
  }

  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
  }
  const sDate = s.toLocaleDateString('en-US', dateOpts)
  const sTime = s.toLocaleTimeString('en-US', timeOpts)
  const eTime = e.toLocaleTimeString('en-US', timeOpts)

  if (s.toDateString() === e.toDateString()) {
    return `${sDate}, ${sTime} - ${eTime}`
  }
  const eDate = e.toLocaleDateString('en-US', dateOpts)
  return `${sDate} ${sTime} - ${eDate} ${eTime}`
}
