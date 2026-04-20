'use client'

import { useState, useEffect } from 'react'
import type { Message, MessageSeverity } from '@/lib/message'
import MessageEditor from '@/components/shared/MessageEditor'

const SEVERITY_STYLES: Record<MessageSeverity, string> = {
  info: 'border-blue-500/50 bg-blue-500/10 text-blue-200',
  success: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-500/50 bg-amber-500/10 text-amber-200',
  alert: 'border-red-500/50 bg-red-500/10 text-red-200 animate-pulse',
}

const SEVERITY_ICON: Record<MessageSeverity, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  alert: '🚨',
}

interface MessageBlockProps {
  initialMessage: Message
}

export default function MessageBlock({ initialMessage }: MessageBlockProps) {
  const [message, setMessage] = useState<Message>(initialMessage)
  const [showEditor, setShowEditor] = useState(false)
  const [showGear, setShowGear] = useState(false)

  // Poll for message changes every 60s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/message')
        const msg = await res.json() as Message
        setMessage(msg)
      } catch {}
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  return (
    <>
      <div className="relative" onMouseEnter={() => setShowGear(true)} onMouseLeave={() => setShowGear(false)}>
        {message.enabled ? (
          <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${SEVERITY_STYLES[message.severity]}`}>
            <span className="text-xl flex-shrink-0">{SEVERITY_ICON[message.severity]}</span>
            <div className="flex-1 min-w-0">
              {message.title && <div className="font-semibold text-sm">{message.title}</div>}
              <div className="text-sm">{message.text}</div>
            </div>
            <button
              onClick={() => setShowEditor(true)}
              className={`flex-shrink-0 p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-all ${showGear ? 'opacity-100' : 'opacity-0'}`}
              title="Edit message"
            >
              ⚙️
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowEditor(true)}
            className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            + add banner
          </button>
        )}
      </div>

      {showEditor && (
        <MessageEditor
          onClose={() => setShowEditor(false)}
          onSaved={(msg) => setMessage(msg)}
        />
      )}
    </>
  )
}
