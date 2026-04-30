'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import 'xterm/css/xterm.css'
import type { ActivityRow } from '@/app/api/agent-activity/route'

// ─── Shared sidebar command definitions ───────────────────────────────────────

const SYSTEM_CMDS = [
  { label: 'uptime',          cmd: 'uptime' },
  { label: 'memory',          cmd: 'free -h' },
  { label: 'disk usage',      cmd: 'df -h' },
  { label: 'top procs (CPU)', cmd: 'ps aux --sort=-%cpu | head -15' },
  { label: 'load avg',        cmd: 'cat /proc/loadavg' },
  { label: 'clear',           cmd: '\x0c' },
]

const PODMAN_CMDS = [
  { label: 'containers',       cmd: 'podman ps -a' },
  { label: 'container stats',  cmd: 'podman stats --no-stream' },
  { label: 'images',           cmd: 'podman images' },
  { label: 'volumes',          cmd: 'podman volume ls' },
  { label: 'failed units',     cmd: 'systemctl --user list-units --failed' },
  { label: 'restart all',      cmd: 'systemctl --user restart compose-stack@*.service' },
]

const NETWORK_CMDS = [
  { label: 'interfaces',       cmd: 'ip -br addr' },
  { label: 'listening ports',  cmd: 'ss -tlnp' },
  { label: 'ping 1.1.1.1',    cmd: 'ping -c3 1.1.1.1' },
  { label: 'routes',           cmd: 'ip route' },
  { label: 'connections',      cmd: 'ss -s' },
]

const LOGS_CMDS = [
  { label: 'recent journal',   cmd: 'journalctl -n 40 --no-pager' },
  { label: 'errors only',      cmd: 'journalctl -p err -n 30 --no-pager' },
  { label: 'kernel msgs',      cmd: 'dmesg -T | tail -20' },
  { label: 'boot log',         cmd: 'journalctl -b -n 30 --no-pager' },
]

const UPDATES_CMDS = [
  { label: 'check updates',    cmd: 'apt list --upgradable 2>/dev/null' },
  { label: 'apt update',       cmd: 'sudo apt update' },
  { label: 'apt upgrade',      cmd: 'sudo apt upgrade -y' },
  { label: 'pull images',      cmd: 'podman images --format "{{.Repository}}:{{.Tag}}" | grep -v "<none>" | xargs -I{} podman pull {}' },
  { label: 'prune images',     cmd: 'podman image prune -f' },
  { label: 'prune volumes',    cmd: 'podman volume prune -f' },
]

const REBOOT_CMDS = [
  { label: 'who is logged in', cmd: 'who' },
  { label: 'scheduled jobs',   cmd: 'systemctl --user list-timers' },
  { label: 'reboot',           cmd: 'sudo reboot' },
  { label: 'shutdown now',     cmd: 'sudo shutdown now' },
]

const TERMINAL_COMMANDS = [
  { category: 'System',   items: SYSTEM_CMDS },
  { category: 'Podman',   items: PODMAN_CMDS },
  { category: 'Network',  items: NETWORK_CMDS },
  { category: 'Logs',     items: LOGS_CMDS },
  { category: 'Updates',  items: UPDATES_CMDS },
  { category: 'Reboot',   items: REBOOT_CMDS },
]

// Quick messages/commands that can be sent via Discord
const DISCORD_QUICK = [
  { label: 'status check',   msg: '!status' },
  { label: 'lab health',     msg: 'how is the lab looking?' },
  { label: 'check queue',    msg: 'what is in the task queue?' },
  { label: 'run security',   msg: 'run a security check' },
  { label: 'check updates',  msg: 'check for system updates' },
]

// ─── Web Terminal tab ─────────────────────────────────────────────────────────

type TermStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

function WebTerminalTab() {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<import('xterm').Terminal | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<TermStatus>('idle')

  const sendCommand = useCallback((cmd: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: cmd === '\x0c' ? cmd : cmd + '\r' }))
      termRef.current?.focus()
    }
  }, [])

  const connect = useCallback(async () => {
    if (status === 'connecting' || status === 'connected') return
    setStatus('connecting')

    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('xterm'),
      import('xterm-addon-fit'),
    ])

    if (!containerRef.current) { setStatus('error'); return }
    containerRef.current.innerHTML = ''

    const term = new Terminal({
      theme: {
        background: '#09090b', foreground: '#e4e4e7', cursor: '#a1a1aa',
        selectionBackground: '#3f3f46',
        black: '#18181b', brightBlack: '#3f3f46',
        red: '#f87171', brightRed: '#fca5a5',
        green: '#4ade80', brightGreen: '#86efac',
        yellow: '#facc15', brightYellow: '#fde047',
        blue: '#60a5fa', brightBlue: '#93c5fd',
        magenta: '#c084fc', brightMagenta: '#d8b4fe',
        cyan: '#22d3ee', brightCyan: '#67e8f9',
        white: '#d4d4d8', brightWhite: '#f4f4f5',
      },
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
    })

    termRef.current = term
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/terminal`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
    }, 25000)

    ws.onopen = () => {
      setStatus('connected')
      ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
    }

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
      } else {
        try { const msg = JSON.parse(e.data); if (msg.type === 'pong') return } catch {}
        term.write(e.data as string)
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      clearInterval(keepalive)
      term.write('\r\n\x1b[2m[session closed — click Connect to start a new session]\x1b[0m\r\n')
    }

    ws.onerror = () => { setStatus('error'); clearInterval(keepalive) }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }))
    })

    term.onResize(({ rows, cols }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', rows, cols }))
    })

    const ro = new ResizeObserver(() => fitAddon.fit())
    ro.observe(containerRef.current)

    cleanupRef.current = () => {
      clearInterval(keepalive)
      ro.disconnect()
      ws.close()
      term.dispose()
      wsRef.current = null
      termRef.current = null
    }
  }, [status])

  const disconnect = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    setStatus('idle')
    if (containerRef.current) containerRef.current.innerHTML = ''
  }, [])

  useEffect(() => () => { cleanupRef.current?.() }, [])

  const isActive = status === 'connected' || status === 'connecting'

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${
            status === 'connected'    ? 'bg-green-400' :
            status === 'connecting'   ? 'bg-amber-400 animate-pulse' :
            status === 'disconnected' ? 'bg-zinc-500' :
            status === 'error'        ? 'bg-red-400' : 'bg-zinc-700'
          }`} />
          <span className="text-xs text-zinc-500 font-mono">
            {status === 'connected'    ? 'svc-podman-01' :
             status === 'connecting'   ? 'connecting…' :
             status === 'disconnected' ? 'disconnected' :
             status === 'error'        ? 'connection error' : 'not connected'}
          </span>
        </div>
        <div className="flex-1" />
        {!isActive ? (
          <button onClick={connect} className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors">
            <span>▶</span> Connect
          </button>
        ) : (
          <button onClick={disconnect} className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-zinc-700 hover:bg-red-700 text-zinc-200 hover:text-white transition-colors">
            <span>■</span> Disconnect
          </button>
        )}
      </div>

      {/* Terminal + sidebar */}
      <div className="flex gap-3 flex-1 min-h-0">
        <div
          ref={containerRef}
          className={`rounded-lg overflow-hidden transition-all ${isActive ? 'flex-1 opacity-100' : 'w-0 opacity-0 pointer-events-none'}`}
          style={{ height: isActive ? '480px' : '0', background: '#09090b' }}
        />
        {isActive && (
          <div className="w-44 flex-shrink-0 flex flex-col gap-0.5 overflow-y-auto max-h-[480px] rounded-lg bg-zinc-900/60 border border-zinc-800 p-1.5">
            {TERMINAL_COMMANDS.map((group) => (
              <div key={group.category}>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-1.5 pt-2 pb-0.5 first:pt-0.5">{group.category}</div>
                {group.items.map((item) => (
                  <button
                    key={item.label}
                    onClick={() => sendCommand(item.cmd)}
                    title={item.cmd === '\x0c' ? 'clear screen (Ctrl+L)' : item.cmd}
                    className="w-full text-left text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 px-2 py-1 rounded transition-colors font-mono truncate block"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {!isActive && status === 'idle' && (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-zinc-600 text-sm">
          <span className="text-2xl">⌨️</span>
          Click <span className="text-green-400 font-medium">Connect</span> to open a shell on svc-podman-01
        </div>
      )}
    </div>
  )
}

// ─── Agent Terminal tab ───────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  thinking:  'text-blue-300',
  tool_call: 'text-yellow-300',
  result:    'text-green-300',
  status:    'text-zinc-300',
  error:     'text-red-300',
  progress:  'text-cyan-300',
}

const TYPE_PREFIX: Record<string, string> = {
  thinking:  '~ ',
  tool_call: '$ ',
  result:    '✓ ',
  status:    '· ',
  error:     '✗ ',
  progress:  '↻ ',
}

const AGENT_FILTER_OPTIONS = [
  { label: 'all',       value: null },
  { label: 'thinking',  value: 'thinking' },
  { label: 'tool_call', value: 'tool_call' },
  { label: 'result',    value: 'result' },
  { label: 'errors',    value: 'error' },
  { label: 'status',    value: 'status' },
]

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function TermLine({ row }: { row: ActivityRow }) {
  const color = TYPE_COLOR[row.activity_type] ?? 'text-zinc-400'
  const prefix = TYPE_PREFIX[row.activity_type] ?? '  '
  return (
    <div className="flex gap-2 leading-5 group">
      <span className="text-zinc-700 text-[10px] tabular-nums flex-shrink-0 mt-0.5 group-hover:text-zinc-500">{formatTime(row.created_at)}</span>
      <span className={`text-[11px] font-mono ${color} break-all`}>
        <span className="opacity-60">{prefix}</span>{row.content}
      </span>
    </div>
  )
}

function AgentTerminalTab({ agent = 'wren' }: { agent?: string }) {
  const [connected, setConnected] = useState(false)
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  const disconnect = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
    setConnected(false)
  }, [])

  const connect = useCallback(() => {
    setError(null)
    setRows([])
    esRef.current?.close()
    const es = new EventSource(`/api/agent-activity/stream?agent=${agent}`)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const { rows: newRows, type } = JSON.parse(e.data)
        if (!Array.isArray(newRows)) return
        if (type === 'init') { setRows(newRows); setConnected(true) }
        else { setRows((prev) => [...prev, ...newRows].slice(-500)) }
      } catch {}
    }

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setConnected(false)
        setError('Stream disconnected — reconnecting...')
        esRef.current = null
        setTimeout(() => { if (!esRef.current) connect() }, 3000)
      }
    }
  }, [agent])

  useEffect(() => () => { esRef.current?.close() }, [])

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [rows])

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40
  }

  const displayRows = filter ? rows.filter((r) => r.activity_type === filter) : rows

  return (
    <div className="flex gap-3 h-full">
      {/* Main feed */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
            <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">
              {connected ? `${agent} · live` : `${agent} · disconnected`}
            </span>
            {connected && <span className="text-[10px] text-zinc-700">{rows.length} lines</span>}
          </div>
          <div className="flex items-center gap-2">
            {connected && (
              <button onClick={() => setRows([])} className="text-[10px] text-zinc-600 hover:text-zinc-400 px-1.5 py-0.5 rounded transition-colors">
                clear
              </button>
            )}
            <button
              onClick={connected ? disconnect : connect}
              className={`text-[10px] font-medium px-2.5 py-1 rounded transition-colors ${
                connected
                  ? 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'
                  : 'bg-blue-900/50 text-blue-300 hover:bg-blue-800/60 border border-blue-800/50'
              }`}
            >
              {connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        </div>

        {/* Feed body */}
        <div className={`font-mono text-xs rounded-lg border transition-colors flex-1 ${connected ? 'bg-zinc-950 border-zinc-800' : 'bg-zinc-950/40 border-zinc-800/40'}`}>
          {!connected ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              {error
                ? <div className="text-red-400 text-[11px]">{error}</div>
                : <div className="text-zinc-700 text-[11px] font-mono"><span className="text-zinc-600">$</span> connect to observe {agent}</div>
              }
              <button onClick={connect} className="text-[11px] font-medium px-4 py-1.5 rounded bg-blue-900/50 text-blue-300 hover:bg-blue-800/60 border border-blue-800/50 transition-colors">
                Connect
              </button>
            </div>
          ) : displayRows.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-zinc-700 text-[11px] font-mono animate-pulse">waiting for activity...</span>
            </div>
          ) : (
            <div ref={scrollRef} onScroll={handleScroll} className="h-[480px] overflow-y-auto p-3 space-y-0.5 scrollbar-thin scrollbar-thumb-zinc-800">
              {displayRows.map((r) => <TermLine key={r.id} row={r} />)}
              <div className="h-px" />
            </div>
          )}
        </div>
      </div>

      {/* Sidebar — filter controls */}
      {connected && (
        <div className="w-44 flex-shrink-0 flex flex-col gap-0.5 rounded-lg bg-zinc-900/60 border border-zinc-800 p-1.5">
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-1.5 pt-0.5 pb-0.5">Filter by type</div>
          {AGENT_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setFilter(opt.value)}
              className={`w-full text-left text-xs px-2 py-1 rounded transition-colors font-mono ${
                filter === opt.value
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60'
              }`}
            >
              {opt.label}
              {opt.value && (
                <span className={`ml-1 text-[10px] ${TYPE_COLOR[opt.value] ?? 'text-zinc-500'}`}>
                  ({rows.filter((r) => r.activity_type === opt.value).length})
                </span>
              )}
              {!opt.value && (
                <span className="ml-1 text-[10px] text-zinc-500">({rows.length})</span>
              )}
            </button>
          ))}

          <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-1.5 pt-3 pb-0.5">Agents</div>
          {['wren', 'iris', 'atlas', 'forge'].map((a) => (
            <button
              key={a}
              onClick={() => {}}
              disabled
              className="w-full text-left text-xs px-2 py-1 rounded text-zinc-600 font-mono cursor-default"
              title="Multi-agent view coming soon"
            >
              {a} {a === agent ? '← active' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Discord tab ──────────────────────────────────────────────────────────────

interface DiscordMessage {
  id: string
  content: string
  author: { username: string; bot: boolean; avatar: string | null }
  timestamp: string
}

function formatDateLabel(ts: string) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatMsgTime(ts: string) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function DiscordTab() {
  const [messages, setMessages] = useState<DiscordMessage[]>([])
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
      if (data.authenticated === false) { setAuthenticated(false); setLoading(false); return }
      if (data.error) { setError(data.error) }
      else { setMessages(data.messages ?? []); setError(null) }
    } catch { setError('Failed to load messages') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const sendMsg = async (content: string) => {
    if (!content || sending) return
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch('/api/discord/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
      const data = await res.json()
      if (!data.ok) { setSendError(data.error ?? 'Send failed') }
      else { setInput(''); atBottomRef.current = true; setTimeout(load, 600) }
    } catch { setSendError('Network error') }
    finally { setSending(false) }
  }

  const send = () => sendMsg(input.trim())

  if (!authenticated) return (
    <div className="text-center py-8 text-zinc-500 text-sm">Sign in to view the Discord bridge</div>
  )

  if (loading) return (
    <div className="flex items-center justify-center h-40">
      <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  type Group = { date: string; msgs: DiscordMessage[] }
  const groups: Group[] = []
  for (const m of messages) {
    const date = formatDateLabel(m.timestamp)
    if (!groups.length || groups[groups.length - 1].date !== date) groups.push({ date, msgs: [m] })
    else groups[groups.length - 1].msgs.push(m)
  }

  return (
    <div className="flex gap-3" style={{ height: '520px' }}>
      {/* Message list + input */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto space-y-0.5 pr-1 scrollbar-thin scrollbar-thumb-zinc-700"
        >
          {error && <div className="text-red-400 text-xs px-2 py-1">{error}</div>}
          {!messages.length && !error && <div className="text-zinc-600 text-xs px-2 py-4 text-center">No messages yet</div>}
          {groups.map((group) => (
            <div key={group.date}>
              <div className="flex items-center gap-2 py-2">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-zinc-600 text-[10px] uppercase tracking-wider">{group.date}</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>
              {group.msgs.map((msg, i) => {
                const prevMsg = i > 0 ? group.msgs[i - 1] : null
                const sameAuthor = prevMsg?.author.username === msg.author.username
                return (
                  <div key={msg.id} className={`flex items-start gap-2 px-1 py-0.5 rounded hover:bg-zinc-800/40 group ${sameAuthor ? 'mt-0' : 'mt-1.5'}`}>
                    {!sameAuthor ? (
                      msg.author.avatar ? (
                        <img src={msg.author.avatar} alt={msg.author.username} className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-indigo-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <span className="text-white text-[9px] font-bold">{msg.author.username[0]?.toUpperCase()}</span>
                        </div>
                      )
                    ) : (
                      <div className="w-6 flex-shrink-0 flex items-center justify-center">
                        <span className="text-zinc-700 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity">{formatMsgTime(msg.timestamp)}</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      {!sameAuthor && (
                        <div className="flex items-baseline gap-1.5 mb-0.5">
                          <span className={`text-xs font-semibold ${msg.author.bot ? 'text-indigo-400' : 'text-zinc-300'}`}>{msg.author.username}</span>
                          {msg.author.bot && <span className="text-[9px] bg-indigo-900/60 text-indigo-400 px-1 rounded">BOT</span>}
                          <span className="text-[10px] text-zinc-600">{formatMsgTime(msg.timestamp)}</span>
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
        <div className="mt-2 flex-shrink-0">
          {sendError && <p className="text-red-400 text-[10px] mb-1 px-1">{sendError}</p>}
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
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
              {sending ? <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin inline-block" /> : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar — quick messages */}
      <div className="w-44 flex-shrink-0 flex flex-col gap-0.5 rounded-lg bg-zinc-900/60 border border-zinc-800 p-1.5">
        <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-1.5 pt-0.5 pb-0.5">Quick Send</div>
        {DISCORD_QUICK.map((item) => (
          <button
            key={item.label}
            onClick={() => sendMsg(item.msg)}
            disabled={sending}
            className="w-full text-left text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 px-2 py-1 rounded transition-colors font-mono disabled:opacity-40"
          >
            {item.label}
          </button>
        ))}

        <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-1.5 pt-3 pb-0.5">Actions</div>
        <button
          onClick={load}
          className="w-full text-left text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 px-2 py-1 rounded transition-colors font-mono"
        >
          refresh
        </button>
        <button
          onClick={() => { atBottomRef.current = true; if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }}
          className="w-full text-left text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 px-2 py-1 rounded transition-colors font-mono"
        >
          scroll to bottom
        </button>
      </div>
    </div>
  )
}

// ─── TerminalHub (tabbed container) ──────────────────────────────────────────

type Tab = 'terminal' | 'agent' | 'discord'

const TABS: { id: Tab; label: string; dot?: string }[] = [
  { id: 'terminal', label: 'Web Terminal' },
  { id: 'agent',    label: 'Agent — Wren' },
  { id: 'discord',  label: 'Discord' },
]

export default function TerminalHub({ popout = false }: { popout?: boolean }) {
  const [activeTab, setActiveTab] = useState<Tab>('terminal')

  function openPopout() {
    window.open(
      '/lab/terminal/popout',
      'terminal-popout',
      'width=1280,height=760,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes'
    )
  }

  // Popout mode — full-height terminal only, no tabs, no popout button
  if (popout) {
    return (
      <div className="flex flex-col flex-1" style={{ height: '100vh', padding: '12px' }}>
        <WebTerminalTab />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-zinc-800 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs font-medium rounded-t-lg transition-colors -mb-px border-b-2 ${
              activeTab === tab.id
                ? 'text-zinc-100 border-zinc-400 bg-zinc-800/60'
                : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/30'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={openPopout}
          title="Open terminal in new window"
          className="px-2 py-1 text-xs text-zinc-600 hover:text-zinc-300 transition-colors rounded hover:bg-zinc-800/40 flex items-center gap-1 mb-0.5"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M6.5 1.75a.75.75 0 0 0 0 1.5h4.69L2.22 12.22a.75.75 0 1 0 1.06 1.06L12.25 4.31v4.69a.75.75 0 0 0 1.5 0V1.75h-7.25Z"/>
          </svg>
          pop out
        </button>
      </div>

      {/* Tab content — fixed height so all tabs match */}
      <div style={{ height: '520px' }} className="overflow-hidden">
        {activeTab === 'terminal' && <WebTerminalTab />}
        {activeTab === 'agent'    && <AgentTerminalTab agent="wren" />}
        {activeTab === 'discord'  && <DiscordTab />}
      </div>
    </div>
  )
}
