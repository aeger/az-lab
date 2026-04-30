'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import 'xterm/css/xterm.css'

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

const COMMANDS = [
  {
    category: 'System',
    items: [
      { label: 'uptime',          cmd: 'uptime' },
      { label: 'memory',          cmd: 'free -h' },
      { label: 'disk usage',      cmd: 'df -h' },
      { label: 'top procs (CPU)', cmd: "ps aux --sort=-%cpu | head -15" },
      { label: 'load avg',        cmd: 'cat /proc/loadavg' },
      { label: 'clear',           cmd: '\x0c' },
    ],
  },
  {
    category: 'Podman',
    items: [
      { label: 'containers',      cmd: 'podman ps -a' },
      { label: 'container stats', cmd: 'podman stats --no-stream' },
      { label: 'images',          cmd: 'podman images' },
      { label: 'volumes',         cmd: 'podman volume ls' },
      { label: 'failed units',    cmd: 'systemctl --user list-units --failed' },
    ],
  },
  {
    category: 'Network',
    items: [
      { label: 'interfaces',      cmd: 'ip -br addr' },
      { label: 'listening ports', cmd: 'ss -tlnp' },
      { label: 'ping 1.1.1.1',   cmd: 'ping -c3 1.1.1.1' },
      { label: 'routes',          cmd: 'ip route' },
      { label: 'connections',     cmd: 'ss -s' },
    ],
  },
  {
    category: 'Logs',
    items: [
      { label: 'recent journal',  cmd: 'journalctl -n 40 --no-pager' },
      { label: 'errors only',     cmd: 'journalctl -p err -n 30 --no-pager' },
      { label: 'kernel msgs',     cmd: 'dmesg -T | tail -20' },
      { label: 'boot log',        cmd: 'journalctl -b -n 30 --no-pager' },
    ],
  },
]

export default function WebTerminal() {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<import('xterm').Terminal | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<Status>('idle')

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
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#a1a1aa',
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
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

    ws.onerror = () => {
      setStatus('error')
      clearInterval(keepalive)
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }))
      }
    })

    term.onResize(({ rows, cols }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', rows, cols }))
      }
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
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${
            status === 'connected'    ? 'bg-green-400' :
            status === 'connecting'   ? 'bg-amber-400 animate-pulse' :
            status === 'disconnected' ? 'bg-zinc-500' :
            status === 'error'        ? 'bg-red-400' :
            'bg-zinc-700'
          }`} />
          <span className="text-xs text-zinc-500 font-mono">
            {status === 'connected'    ? 'svc-podman-01' :
             status === 'connecting'   ? 'connecting…' :
             status === 'disconnected' ? 'disconnected' :
             status === 'error'        ? 'connection error' :
             'not connected'}
          </span>
        </div>
        <div className="flex-1" />
        {!isActive ? (
          <button
            onClick={connect}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors"
          >
            <span>▶</span> Connect
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-zinc-700 hover:bg-red-700 text-zinc-200 hover:text-white transition-colors"
          >
            <span>■</span> Disconnect
          </button>
        )}
      </div>

      {/* Terminal + command palette */}
      <div className="flex gap-3">
        {/* Terminal pane — always rendered so xterm can mount */}
        <div
          ref={containerRef}
          className={`rounded-lg overflow-hidden transition-all ${
            isActive ? 'flex-1 opacity-100' : 'w-0 opacity-0 pointer-events-none'
          }`}
          style={{ height: isActive ? '400px' : '0', background: '#09090b' }}
        />

        {/* Command palette — visible only when connected */}
        {isActive && (
          <div className="w-40 flex-shrink-0 flex flex-col gap-0.5 overflow-y-auto max-h-[400px] rounded-lg bg-zinc-900/60 border border-zinc-800 p-1.5">
            {COMMANDS.map((group) => (
              <div key={group.category}>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider px-1.5 pt-2 pb-0.5 first:pt-0.5">
                  {group.category}
                </div>
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

      {/* Idle placeholder */}
      {!isActive && status === 'idle' && (
        <div className="flex flex-col items-center justify-center h-24 gap-2 text-zinc-600 text-sm">
          <span className="text-2xl">⌨️</span>
          Click <span className="text-green-400 font-medium">Connect</span> to open a shell on svc-podman-01
        </div>
      )}
    </div>
  )
}
