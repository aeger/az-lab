'use client'

import { useState, useEffect, useRef } from 'react'
import type { QuickLink } from '@/lib/config'

// Shared admin secret helpers (same key as FeedEditor)
const LS_KEY = 'az_dashboard_secret'
const SECRET_TTL_MS = 24 * 60 * 60 * 1000

function loadCachedSecret(): string | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const { s, exp } = JSON.parse(raw)
    if (Date.now() > exp) { localStorage.removeItem(LS_KEY); return null }
    return s
  } catch { return null }
}

function persistSecret(s: string) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ s, exp: Date.now() + SECRET_TTL_MS })) } catch {}
}

const KNOWN_ICONS: { value: string; emoji: string; label: string }[] = [
  { value: 'photos', emoji: '🖼️', label: 'Photos' },
  { value: 'immich', emoji: '🖼️', label: 'Immich' },
  { value: 'gmail', emoji: '✉️', label: 'Gmail' },
  { value: 'prime', emoji: '📦', label: 'Prime Video' },
  { value: 'netflix', emoji: '🎬', label: 'Netflix' },
  { value: 'youtube', emoji: '▶️', label: 'YouTube' },
  { value: 'disney', emoji: '🏰', label: 'Disney+' },
  { value: 'amp', emoji: '🎮', label: 'AMP / Games' },
  { value: 'adguard', emoji: '🛡️', label: 'AdGuard' },
  { value: 'proxmox', emoji: '🖥️', label: 'Proxmox' },
  { value: 'portainer', emoji: '🐳', label: 'Portainer' },
  { value: 'grafana', emoji: '📊', label: 'Grafana' },
  { value: 'traefik', emoji: '🔀', label: 'Traefik' },
  { value: 'uptime-kuma', emoji: '📡', label: 'Uptime Kuma' },
  { value: 'calibre', emoji: '📚', label: 'Calibre' },
  { value: 'audiobookshelf', emoji: '🎧', label: 'Audiobookshelf' },
  { value: 'changedetect', emoji: '🔔', label: 'Changedetection' },
  { value: 'shelfmark', emoji: '🏷️', label: 'Shelfmark' },
  { value: 'grocy', emoji: '🛒', label: 'Grocy' },
  { value: 'homeassistant', emoji: '🏠', label: 'Home Assistant' },
  { value: 'webmin', emoji: '⚙️', label: 'Webmin' },
]

interface QuickLinkEditorProps {
  section: 'home' | 'lab'
  existingLinks: QuickLink[]
  editLink?: { link: QuickLink; index: number } // undefined = add new
  onClose: () => void
  onSaved: (section: 'home' | 'lab', links: QuickLink[]) => void
}

export default function QuickLinkEditor({
  section,
  existingLinks,
  editLink,
  onClose,
  onSaved,
}: QuickLinkEditorProps) {
  const isEdit = editLink !== undefined
  const sectionLabel = section === 'home' ? 'Home' : 'Lab'

  const [step, setStep] = useState<'auth' | 'edit'>(() => loadCachedSecret() ? 'edit' : 'auth')
  const [secret, setSecret] = useState(() => loadCachedSecret() ?? '')
  const [authError, setAuthError] = useState('')

  const [name, setName] = useState(editLink?.link.name ?? '')
  const [url, setUrl] = useState(editLink?.link.url ?? '')
  const [icon, setIcon] = useState(editLink?.link.icon ?? '')
  const [color, setColor] = useState(editLink?.link.color ?? '#71717a')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const secretRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step === 'auth') secretRef.current?.focus()
    else nameRef.current?.focus()
  }, [step])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(links: QuickLink[], sec: string) {
    const res = await fetch('/api/quicklinks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ section: sec, links }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) throw new Error('wrong_secret')
      throw new Error(data.error ?? 'Save failed')
    }
    persistSecret(secret)
  }

  async function handleSave() {
    if (!name.trim() || !url.trim()) { setError('Name and URL are required'); return }
    try { new URL(url) } catch { setError('Enter a valid URL'); return }

    setSaving(true)
    setError('')
    try {
      let updated: QuickLink[]
      const link: QuickLink = {
        name: name.trim(),
        url: url.trim(),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(color && color !== '#71717a' ? { color } : {}),
      }
      if (isEdit && editLink !== undefined) {
        updated = existingLinks.map((l, i) => (i === editLink.index ? link : l))
      } else {
        updated = [...existingLinks, link]
      }
      await save(updated, section)
      onSaved(section, updated)
      onClose()
    } catch (e) {
      if (e instanceof Error && e.message === 'wrong_secret') {
        localStorage.removeItem(LS_KEY)
        setSecret('')
        setStep('auth')
        setAuthError('Incorrect secret')
      } else {
        setError(e instanceof Error ? e.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!isEdit || editLink === undefined) return
    setSaving(true)
    setError('')
    try {
      const updated = existingLinks.filter((_, i) => i !== editLink.index)
      await save(updated, section)
      onSaved(section, updated)
      onClose()
    } catch (e) {
      if (e instanceof Error && e.message === 'wrong_secret') {
        localStorage.removeItem(LS_KEY)
        setSecret('')
        setStep('auth')
        setAuthError('Incorrect secret')
      } else {
        setError(e instanceof Error ? e.message : 'Delete failed')
      }
    } finally {
      setSaving(false)
    }
  }

  function handleAuth(e: React.FormEvent) {
    e.preventDefault()
    if (!secret.trim()) return
    setAuthError('')
    setStep('edit')
  }

  const iconEmoji = KNOWN_ICONS.find((i) => i.value === icon)?.emoji ?? null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold text-white">
              {isEdit ? 'Edit Link' : 'Add Quick Link'}
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">{sectionLabel} section</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors text-lg p-1 rounded">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {step === 'auth' ? (
            <form onSubmit={handleAuth} className="space-y-3">
              <p className="text-sm text-zinc-400">Enter admin secret to manage quick links.</p>
              <input
                ref={secretRef}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Admin secret"
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
              />
              {authError && <p className="text-xs text-red-400">{authError}</p>}
              <button
                type="submit"
                disabled={!secret.trim()}
                className="w-full py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >Continue</button>
            </form>
          ) : (
            <>
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Name</label>
                <input
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Service"
                  maxLength={40}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
                />
              </div>

              {/* URL */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">URL</label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://service.az-lab.dev"
                  className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
                />
              </div>

              {/* Icon + Color row */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Icon</label>
                  <div className="relative">
                    <select
                      value={icon}
                      onChange={(e) => setIcon(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white focus:outline-none focus:border-zinc-500 transition-colors appearance-none pr-7"
                    >
                      <option value="">— none (use initial) —</option>
                      {KNOWN_ICONS.map((i) => (
                        <option key={i.value} value={i.value}>{i.emoji} {i.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      className="w-8 h-9 rounded cursor-pointer bg-transparent border-0 p-0"
                      title="Pick a color"
                    />
                    <input
                      type="text"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      maxLength={7}
                      className="w-24 px-2 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-white font-mono focus:outline-none focus:border-zinc-500 transition-colors"
                    />
                  </div>
                </div>
              </div>

              {/* Preview */}
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <span className="text-xs text-zinc-500">Preview:</span>
                {iconEmoji ? (
                  <span className="text-sm">{iconEmoji}</span>
                ) : (
                  <span
                    className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold"
                    style={{ background: `${color}22`, color }}
                  >
                    {name[0] ?? '?'}
                  </span>
                )}
                <span className="text-sm text-zinc-300 truncate">{name || 'Link name'}</span>
                <span className="text-zinc-600 text-xs ml-auto">↗</span>
              </div>

              {error && <p className="text-xs text-red-400">{error}</p>}

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                {isEdit && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={saving}
                    className="px-3 py-2 rounded-lg border border-red-800/50 text-red-500 hover:bg-red-500/10 text-xs font-medium transition-colors disabled:opacity-50"
                  >Remove</button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white text-sm transition-colors"
                >Cancel</button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !name.trim() || !url.trim()}
                  className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >{saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Link'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
