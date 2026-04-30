'use client'

import { useEffect, useState } from 'react'

export default function ClockWidget() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const interval = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(interval)
  }, [])

  if (!now) return <div className="h-14" />

  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div>
      <div className="text-4xl font-light tracking-tight text-white tabular-nums">{time}</div>
      <div className="text-sm text-zinc-400 mt-0.5">{date}</div>
    </div>
  )
}
