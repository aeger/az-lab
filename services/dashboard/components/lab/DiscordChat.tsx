'use client'
import { useEffect, useRef, useState, useCallback } from 'react'

interface Message {
  id: string
  content: string
  author: { username: string; bot: boolean; avatar: string | null }
  timestamp: string
}

function formatTime(ts: string) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(ts: string) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function DiscordChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/discord/messages?limit=50')
      const data = await res.json()
      if (data.authenticated === false) {
        setAuthenticated(false)
        setLoading(false)
        return
      }
      if (data.error) {
        setError(data.error)
      } else {
        setMessages(data.messages ?? [])
        setError(null)
      }
    } catch {
      setError('Failed to load messages')
    } finally {
      setLoading(false)
    }
  }, [])

  // Scroll to bottom when new messages arrive (only if already at bottom)
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Initial load + 30s refresh
  useEffect(() => {
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [load])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const send = async () => {
    const content = input.trim()
    if (!content || sending) return
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch('/api/discord/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = await res.json()
      if (!data.ok) {
        setSendError(data.error ?? 'Send failed')
      } else {
        setInput('')
        atBottomRef.current = true
        // Refresh after short delay to pick up the new message
        setTimeout(load, 600)
      }
    } catch {
      setSendError('Network error')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  if (!authenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-3">
        <span className="text-2xl">💬</span>
        <p className="text-sm text-zinc-500">Sign in to view the Discord bridge</p>
        <a
          href="https://auth.az-lab.dev/?rd=https://home.az-lab.dev"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
        >
          <span>🔑</span> Sign In
        </a>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Group messages by date for dividers
  type Group = { date: string; msgs: Message[] }
  const groups: Group[] = []
  for (const m of messages) {
    const date = formatDate(m.timestamp)
    if (groups.length === 0 || groups[groups.length - 1].date !== date) {
      groups.push({ date, msgs: [m] })
    } else {
      groups[groups.length - 1].msgs.push(m)
    }
  }

  return (
    <div className="flex flex-col h-72">
      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto space-y-0.5 pr-1 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent"
      >
        {error && (
          <div className="text-red-400 text-xs px-2 py-1">{error}</div>
        )}
        {messages.length === 0 && !error && (
          <div className="text-zinc-600 text-xs px-2 py-4 text-center">No messages yet</div>
        )}
        {groups.map((group) => (
          <div key={group.date}>
            {/* Date divider */}
            <div className="flex items-center gap-2 py-2">
              <div className="flex-1 h-px bg-zinc-800" />
              <span className="text-zinc-600 text-[10px] uppercase tracking-wider">{group.date}</span>
              <div className="flex-1 h-px bg-zinc-800" />
            </div>
            {group.msgs.map((msg, i) => {
              const prevMsg = i > 0 ? group.msgs[i - 1] : null
              const sameAuthor = prevMsg?.author.username === msg.author.username
              return (
                <div
                  key={msg.id}
                  className={`flex items-start gap-2 px-1 py-0.5 rounded hover:bg-zinc-800/40 group ${sameAuthor ? 'mt-0' : 'mt-1.5'}`}
                >
                  {/* Avatar / spacer */}
                  {!sameAuthor ? (
                    msg.author.avatar ? (
                      <img
                        src={msg.author.avatar}
                        alt={msg.author.username}
                        className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-indigo-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-white text-[9px] font-bold">
                          {msg.author.username[0]?.toUpperCase()}
                        </span>
                      </div>
                    )
                  ) : (
                    <div className="w-6 flex-shrink-0 flex items-center justify-center">
                      <span className="text-zinc-700 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    {!sameAuthor && (
                      <div className="flex items-baseline gap-1.5 mb-0.5">
                        <span className={`text-xs font-semibold ${msg.author.bot ? 'text-indigo-400' : 'text-zinc-300'}`}>
                          {msg.author.username}
                        </span>
                        {msg.author.bot && (
                          <span className="text-[9px] bg-indigo-900/60 text-indigo-400 px-1 rounded">BOT</span>
                        )}
                        <span className="text-[10px] text-zinc-600">{formatTime(msg.timestamp)}</span>
                      </div>
                    )}
                    <p className="text-xs text-zinc-300 break-words leading-relaxed whitespace-pre-wrap">
                      {msg.content || <span className="text-zinc-600 italic">[no text content]</span>}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Input bar */}
      <div className="mt-2 flex-shrink-0">
        {sendError && (
          <p className="text-red-400 text-[10px] mb-1 px-1">{sendError}</p>
        )}
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message…"
            maxLength={2000}
            disabled={sending}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-600 disabled:opacity-50 transition-colors"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
          >
            {sending ? (
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
              </span>
            ) : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
