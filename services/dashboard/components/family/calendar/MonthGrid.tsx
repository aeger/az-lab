'use client'

interface CalendarEvent {
  start: string
  calendarColor: string
}

interface MonthGridProps {
  currentMonth: Date
  events: CalendarEvent[]
  selectedDate: Date | null
  onSelectDate: (date: Date) => void
  onPrevMonth: () => void
  onNextMonth: () => void
  onToday: () => void
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default function MonthGrid({
  currentMonth,
  events,
  selectedDate,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
  onToday,
}: MonthGridProps) {
  const year = currentMonth.getFullYear()
  const month = currentMonth.getMonth()
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysInPrevMonth = new Date(year, month, 0).getDate()

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Build cells
  const cells: { date: Date; inMonth: boolean }[] = []

  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, daysInPrevMonth - i), inMonth: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), inMonth: true })
  }
  const remaining = Math.ceil(cells.length / 7) * 7 - cells.length
  for (let d = 1; d <= remaining; d++) {
    cells.push({ date: new Date(year, month + 1, d), inMonth: false })
  }

  // Parse date string as local time (YYYY-MM-DD all-day events must not be
  // parsed as UTC, which shifts them back a day in US timezones)
  const parseLocal = (s: string) => {
    if (s.length === 10) {
      const [y, m, d] = s.split('-').map(Number)
      return new Date(y, m - 1, d)
    }
    return new Date(s)
  }

  // Event dots by date
  const dotsByDate = new Map<string, Set<string>>()
  for (const event of events) {
    const dateKey = parseLocal(event.start).toDateString()
    if (!dotsByDate.has(dateKey)) dotsByDate.set(dateKey, new Set())
    dotsByDate.get(dateKey)!.add(event.calendarColor)
  }

  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() === month

  return (
    <div className="select-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-zinc-200">
            {MONTH_NAMES[month]} {year}
          </h3>
          <button
            onClick={onToday}
            title="Go to today"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" />
              <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
        <div className="flex gap-1">
          <button
            onClick={onPrevMonth}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={onNextMonth}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-2">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
          <div key={d} className="text-center text-xs font-medium text-zinc-500 py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map(({ date, inMonth }, i) => {
          const isToday = date.toDateString() === today.toDateString()
          const isSelected = selectedDate?.toDateString() === date.toDateString()
          const dots = dotsByDate.get(date.toDateString())

          return (
            <button
              key={i}
              onClick={() => onSelectDate(date)}
              className={`
                relative flex flex-col items-center py-2 rounded-lg transition-colors text-sm
                ${inMonth ? 'text-zinc-300 hover:bg-zinc-700/50' : 'text-zinc-600 hover:bg-zinc-800/50'}
                ${isSelected && !isToday ? 'bg-zinc-700/60 ring-1 ring-zinc-500' : ''}
                ${isToday ? 'bg-blue-600/25 text-blue-300 font-bold' : ''}
              `}
            >
              <span>{date.getDate()}</span>
              <div className="flex gap-0.5 mt-1 h-2">
                {dots &&
                  [...dots].slice(0, 4).map((color, j) => (
                    <div
                      key={j}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ))}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
