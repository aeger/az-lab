'use client'

import { useEffect, useState, useCallback } from 'react'

interface GmailMessage {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
  date: string
  unread: boolean
}

interface GmailState {
  status: 'loading' | 'unauthenticated' | 'reauth' | 'ready' | 'error'
  messages: GmailMessage[]
}

interface TriageState {
  status: 'idle' | 'running' | 'queued' | 'error'
  lastRun?: string
  taskId?: string
}

type Tab = 'all' | 'promotions' | 'social' | 'updates'

const TABS: { id: Tab; label: string }[] = [
  { id: 'all',        label: 'All' },
  { id: 'promotions', label: 'Promos' },
  { id: 'social',     label: 'Social' },
  { id: 'updates',    label: 'Updates' },
]

const AUTH_LOGIN_URL = 'https://auth.az-lab.dev/?rd=https://home.az-lab.dev'
const REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

export default function GmailWidget() {
  const [state, setState] = useState<GmailState>({ status: 'loading', messages: [] })
  const [triage, setTriage] = useState<TriageState>({ status: 'idle' })
  const [activeTab, setActiveTab] = useState<Tab>('all')
  const [tabLoading, setTabLoading] = useState(false)

  async function runTriage() {
    setTriage({ status: 'running' })
    try {
      const res = await fetch('/api/email/triage', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        setTriage({ status: 'queued', lastRun: data.queuedAt, taskId: data.taskId })
      } else {
        setTriage({ status: 'error' })
      }
    } catch {
      setTriage({ status: 'error' })
    }
  }

  const load = useCallback(async (tab: Tab = activeTab, initial = false) => {
    if (!initial) setTabLoading(true)
    try {
      const res = await fetch(`/api/gmail?tab=${tab}`)
      const data = await res.json()

      if (!data.authenticated) {
        setState({ status: 'unauthenticated', messages: [] })
        return
      }
      if (data.reauth_required) {
        setState({ status: 'reauth', messages: [] })
        return
      }
      if (data.error) {
        setState({ status: 'error', messages: [] })
        return
      }
      setState({ status: 'ready', messages: data.messages ?? [] })
    } catch {
      setState({ status: 'error', messages: [] })
    } finally {
      setTabLoading(false)
    }
  }, [activeTab])

  useEffect(() => {
    load(activeTab, true)
    const timer = setInterval(() => load(activeTab), REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [activeTab, load])

  function switchTab(tab: Tab) {
    if (tab === activeTab) return
    setActiveTab(tab)
    setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : s.status, messages: [] }))
  }

  function TriageButton() {
    const isRunning = triage.status === 'running'
    const isQueued = triage.status === 'queued'
    const isError = triage.status === 'error'
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={runTriage}
          disabled={isRunning || isQueued}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
            isQueued ? 'bg-green-900/40 border-green-700/50 text-green-400 cursor-default'
            : isError ? 'bg-red-900/30 border-red-700/50 text-red-400 hover:bg-red-900/50'
            : isRunning ? 'bg-zinc-800 border-zinc-700 text-zinc-400 cursor-wait'
            : 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-300 hover:text-white'
          }`}
        >
          {isRunning ? (
            <><span className="w-3 h-3 border border-zinc-500 border-t-zinc-300 rounded-full animate-spin" />Running…</>
          ) : isQueued ? <>✓ Queued</>
          : isError ? <>⚠ Error</>
          : <>▶ Run Triage</>}
        </button>
        {isQueued && triage.lastRun && (
          <span className="text-xs text-zinc-600">{formatDate(triage.lastRun)}</span>
        )}
      </div>
    )
  }

  // ── loading / unauth / reauth / error states ──────────────────────────────

  if (state.status === 'loading') {
    return (
      <div>
        <div className="flex justify-end mb-2"><TriageButton /></div>
        <div className="flex items-center justify-center h-32">
          <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      </div>
    )
  }

  if (state.status === 'unauthenticated') {
    return (
      <div>
        <div className="flex justify-end mb-2"><TriageButton /></div>
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="text-zinc-500 text-sm">Sign in to view your inbox</div>
          <a href={AUTH_LOGIN_URL}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-300 hover:text-white transition-all">
            Sign in
          </a>
        </div>
      </div>
    )
  }

  if (state.status === 'reauth') {
    return (
      <div>
        <div className="flex justify-end mb-2"><TriageButton /></div>
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="text-zinc-500 text-sm text-center">Gmail token expired or invalid</div>
          <a href="/api/gmail/auth"
            className="px-4 py-2 rounded-lg bg-blue-900/50 hover:bg-blue-800/60 border border-blue-700/50 text-sm text-blue-300 hover:text-blue-100 transition-all">
            Re-authorize Gmail
          </a>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div>
        <div className="flex justify-end mb-2"><TriageButton /></div>
        <div className="text-zinc-500 text-sm text-center py-8">Unable to load mail</div>
      </div>
    )
  }

  // ── ready ─────────────────────────────────────────────────────────────────

  const unreadCount = state.messages.filter((m) => m.unread).length

  return (
    <div>
      {/* Header row */}
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <span className="text-xs text-blue-400">{unreadCount} unread</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TriageButton />
          <button onClick={() => load(activeTab)} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            refresh
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0.5 border-b border-zinc-800 mb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => switchTab(t.id)}
            className={`px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors -mb-px border-b-2 ${
              t.id === activeTab
                ? 'text-zinc-100 border-purple-400'
                : 'text-zinc-500 border-transparent hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Message list */}
      {tabLoading ? (
        <div className="flex items-center justify-center h-24">
          <div className="w-4 h-4 border-2 border-zinc-700 border-t-purple-400 rounded-full animate-spin" />
        </div>
      ) : state.messages.length === 0 ? (
        <div className="text-zinc-500 text-sm text-center py-6">
          {activeTab === 'all' ? 'Inbox zero — nice work' : `No ${TABS.find(t => t.id === activeTab)?.label ?? activeTab} messages`}
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {state.messages.map((msg) => (
            <li key={msg.id}>
              <a
                href={`https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block group py-1.5"
              >
                <div className="flex items-start gap-2">
                  {msg.unread && <span className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />}
                  <div className={`flex-1 min-w-0 ${!msg.unread ? 'ml-4' : ''}`}>
                    <div className="flex justify-between gap-2">
                      <span className={`text-sm truncate ${msg.unread ? 'text-zinc-100 font-medium' : 'text-zinc-300'} group-hover:text-white transition-colors`}>
                        {parseSender(msg.from)}
                      </span>
                      <span className="text-xs text-zinc-500 flex-shrink-0 mt-0.5">{formatDate(msg.date)}</span>
                    </div>
                    <div className={`text-sm truncate ${msg.unread ? 'text-zinc-300' : 'text-zinc-400'}`}>
                      {msg.subject}
                    </div>
                    <div className="text-xs text-zinc-600 truncate mt-0.5">{msg.snippet}</div>
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function parseSender(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1].trim() : from.split('@')[0]
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diff = (now.getTime() - d.getTime()) / 1000 / 60
    if (diff < 60) return `${Math.round(diff)}m`
    if (diff < 1440) return `${Math.round(diff / 60)}h`
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  } catch {
    return ''
  }
}
