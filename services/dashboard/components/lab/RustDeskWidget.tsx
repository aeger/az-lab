'use client'

import { useEffect, useState, useCallback } from 'react'
import type { RustDeskRemote } from '@/app/api/rustdesk/remotes/route'
import type { PeerInfo } from '@/app/api/rustdesk/sync/route'

// ── Types ───────────────────────────────────────────────────────────────────

interface RustDeskStatus {
  configured: boolean
  hbbs?: boolean
  hbbr?: boolean
  host?: string
}

type Tab = 'list' | 'create' | 'edit'

const EMPTY_FORM = { peerId: '', name: '', password: '', group: '', note: '' }

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

// ── Sub-components ──────────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
        active ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  )
}

function Field({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
      />
    </div>
  )
}

// ── Remote form ─────────────────────────────────────────────────────────────

function RemoteForm({
  initial,
  isEdit,
  onSave,
  onCancel,
}: {
  initial: typeof EMPTY_FORM & { id?: string }
  isEdit: boolean
  onSave: (r: RustDeskRemote) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(key: keyof typeof EMPTY_FORM, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit() {
    setError('')
    setSaving(true)
    try {
      const url = isEdit ? `/api/rustdesk/remotes/${initial.id}` : '/api/rustdesk/remotes'
      const method = isEdit ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Save failed'); return }
      onSave(data)
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Peer ID (numeric)" value={form.peerId} onChange={(v) => set('peerId', v)} placeholder="123456789" />
        <Field label="Name" value={form.name} onChange={(v) => set('name', v)} placeholder="My Desktop" />
        <Field label="Password (optional)" value={form.password} onChange={(v) => set('password', v)} type="password" placeholder="saved password" />
        <Field label="Group / Tag (optional)" value={form.group} onChange={(v) => set('group', v)} placeholder="home, work…" />
        <div className="sm:col-span-2">
          <Field label="Note (optional)" value={form.note} onChange={(v) => set('note', v)} placeholder="short description" />
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md transition-colors"
        >
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Remote'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-xs font-medium text-zinc-400 hover:text-white transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Remote list ─────────────────────────────────────────────────────────────

function RemoteList({
  remotes,
  peers,
  onEdit,
  onDelete,
  onConnect,
}: {
  remotes: RustDeskRemote[]
  peers: PeerInfo[]
  onEdit: (r: RustDeskRemote) => void
  onDelete: (id: string) => void
  onConnect: (peerId: string) => void
}) {
  const peerMap = Object.fromEntries(peers.map(p => [p.peerId, p]))
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      await fetch(`/api/rustdesk/remotes/${id}`, { method: 'DELETE' })
      onDelete(id)
    } finally {
      setDeleting(null)
      setConfirmId(null)
    }
  }

  function copyId(peerId: string) {
    navigator.clipboard.writeText(peerId).then(() => {
      setCopied(peerId)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  if (remotes.length === 0) {
    return <p className="text-xs text-zinc-600 py-3">No saved remotes. Add one to get started.</p>
  }

  return (
    <div className="space-y-2">
      {remotes.map((r) => {
        const peer = peerMap[r.peerId]
        // Green = registered in relay DB, gray = not in DB (OSS hbbs doesn't expose real-time presence)
        const dotColor = peer ? '#4ade80' : '#3f3f46'
        const dotTitle = peer ? `Registered with relay · first seen ${peer.lastSeen}` : 'Not found in relay DB'
        return (
        <div key={r.id} className="flex items-start justify-between gap-3 bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} title={dotTitle} />
              <span className="text-sm font-medium text-white">{r.name}</span>
              {r.group && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-400">{r.group}</span>
              )}
              {r.password && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800/50">
                  pw saved
                </span>
              )}
              {peer && (
                <span className="text-[10px] text-zinc-600 ml-auto" title="First registered with relay">reg. {relativeTime(peer.lastSeen)}</span>
              )}
            </div>
            <button
              onClick={() => copyId(r.peerId)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors font-mono mt-0.5"
              title="Copy Peer ID"
            >
              {copied === r.peerId ? 'Copied!' : `ID: ${r.peerId}`}
            </button>
            {r.note && <div className="text-xs text-zinc-600 truncate mt-0.5">{r.note}</div>}
          </div>

          <div className="flex gap-1.5 flex-shrink-0 items-center">
            {confirmId === r.id ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => handleDelete(r.id)}
                  disabled={deleting === r.id}
                  className="text-[10px] px-2 py-1 bg-red-700 hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50"
                >
                  {deleting === r.id ? '…' : 'Confirm'}
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => onConnect(r.peerId)}
                  className="text-[10px] px-2 py-1 bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors"
                  title="Connect"
                >
                  Connect
                </button>
                <button
                  onClick={() => onEdit(r)}
                  className="text-[10px] px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmId(r.id)}
                  className="text-[10px] px-2 py-1 bg-zinc-800 hover:bg-red-900/60 text-zinc-400 hover:text-red-300 rounded transition-colors border border-zinc-700"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        )
      })}
    </div>
  )
}

// ── Main widget ─────────────────────────────────────────────────────────────

export default function RustDeskWidget() {
  const [tab, setTab] = useState<Tab>('list')
  const [remotes, setRemotes] = useState<RustDeskRemote[]>([])
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [status, setStatus] = useState<RustDeskStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [editTarget, setEditTarget] = useState<RustDeskRemote | null>(null)
  const [quickId, setQuickId] = useState('')
  const [showQuick, setShowQuick] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes, remotesRes, syncRes] = await Promise.all([
        fetch('/api/rustdesk'),
        fetch('/api/rustdesk/remotes'),
        fetch('/api/rustdesk/sync'),
      ])
      if (statusRes.ok) setStatus(await statusRes.json())
      if (remotesRes.ok) setRemotes(await remotesRes.json())
      if (syncRes.ok) {
        const d = await syncRes.json()
        setPeers(d.peers ?? [])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  const autoSync = useCallback(async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/rustdesk/sync', { method: 'POST' })
      const d = await res.json()
      setSyncResult(`+${d.added} added, −${d.removed} removed, ${d.unchanged} unchanged`)
      await load()
    } catch {
      setSyncResult('sync failed')
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncResult(null), 4000)
    }
  }, [load])

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [load])

  function handleConnect(peerId: string) {
    window.open(`rustdesk://connection/new/${peerId}`, '_self')
  }

  function handleEdit(r: RustDeskRemote) {
    setEditTarget(r)
    setTab('edit')
  }

  function handleDelete(id: string) {
    setRemotes((prev) => prev.filter((r) => r.id !== id))
  }

  function handleSaved(r: RustDeskRemote) {
    setRemotes((prev) => {
      const idx = prev.findIndex((x) => x.id === r.id)
      if (idx >= 0) { const next = [...prev]; next[idx] = r; return next }
      return [...prev, r].sort((a, b) => a.name.localeCompare(b.name))
    })
    setEditTarget(null)
    setTab('list')
  }

  const serverUp = status?.hbbs && status?.hbbr

  return (
    <div>
      {/* Server status bar */}
      {status?.configured !== false && (
        <div className="flex items-center justify-between text-xs px-1 mb-3">
          <div className={`flex items-center gap-1.5 ${serverUp ? 'text-emerald-400' : 'text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${serverUp ? 'bg-emerald-400' : 'bg-red-400'}`} />
            {serverUp ? 'Server Online' : status ? 'Server Issue' : 'Checking…'}
            {status && !serverUp && (
              <span className="text-zinc-500 ml-1">
                {!status.hbbs && 'hbbs↓'} {!status.hbbr && 'hbbr↓'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {syncResult && <span className="text-zinc-500 text-[10px]">{syncResult}</span>}
            <button
              onClick={autoSync}
              disabled={syncing}
              className="text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40 text-[10px] font-mono"
              title="Auto-sync remotes from relay DB"
            >
              {syncing ? '↻' : 'sync db'}
            </button>
            {status?.host && <span className="text-zinc-600">{status.host}</span>}
            <button
              onClick={() => setShowQuick(!showQuick)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Quick connect by ID"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Quick connect input */}
      {showQuick && (
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={quickId}
            onChange={(e) => setQuickId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && quickId.trim() && handleConnect(quickId.trim())}
            placeholder="Enter Peer ID to connect"
            className="flex-1 px-2.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            autoFocus
          />
          <button
            onClick={() => { if (quickId.trim()) handleConnect(quickId.trim()) }}
            disabled={!quickId.trim()}
            className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs transition-colors disabled:opacity-40"
          >
            Connect
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-0.5 border-b border-zinc-800 mb-4 pb-1">
        <TabBtn active={tab === 'list'} onClick={() => { setTab('list'); setEditTarget(null) }}>
          Remotes ({remotes.length})
        </TabBtn>
        <TabBtn active={tab === 'create'} onClick={() => { setTab('create'); setEditTarget(null) }}>
          + New
        </TabBtn>
        {tab === 'edit' && editTarget && (
          <TabBtn active={true} onClick={() => {}}>
            Editing: {editTarget.name}
          </TabBtn>
        )}
        <div className="ml-auto">
          <button
            onClick={load}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors px-2 py-1"
            title="Refresh"
          >
            ↺
          </button>
        </div>
      </div>

      {/* Content */}
      {tab === 'list' && (
        loading ? (
          <p className="text-xs text-zinc-600">Loading…</p>
        ) : (
          <RemoteList
            remotes={remotes}
            peers={peers}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onConnect={handleConnect}
          />
        )
      )}

      {tab === 'create' && (
        <RemoteForm
          initial={{ ...EMPTY_FORM }}
          isEdit={false}
          onSave={handleSaved}
          onCancel={() => setTab('list')}
        />
      )}

      {tab === 'edit' && editTarget && (
        <RemoteForm
          initial={{ ...EMPTY_FORM, ...editTarget, password: editTarget.password ?? '', group: editTarget.group ?? '', note: editTarget.note ?? '' }}
          isEdit={true}
          onSave={handleSaved}
          onCancel={() => { setTab('list'); setEditTarget(null) }}
        />
      )}
    </div>
  )
}
