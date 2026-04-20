'use client'

import { useState, useRef, useEffect } from 'react'

interface Feed {
  url: string
  name: string
}

interface FeedHealth {
  ok: boolean
  checkedAt: string
  lastSuccess?: string
  itemCount?: number
  error?: string
  fetchDurationMs?: number
}

interface TestResult {
  ok: boolean
  itemCount?: number
  preview?: Array<{ title: string; pubDate: string }>
  error?: string
}

interface FeedEditorProps {
  type: 'family' | 'lab'
  onClose: () => void
  onSaved: () => void
}

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

function persistSecret(secret: string) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ s: secret, exp: Date.now() + SECRET_TTL_MS }))
  } catch {}
}

function forgetSecret() {
  try { localStorage.removeItem(LS_KEY) } catch {}
}

function autoName(url: string): string {
  try {
    const reddit = url.match(/reddit\.com\/r\/([^/.?#]+)/i)
    if (reddit) return `r/${reddit[1]}`
    return new URL(url).hostname.replace(/^www\./, '')
  } catch { return '' }
}

function validateUrl(url: string, existing: Feed[]): string {
  const trimmed = url.trim()
  if (!trimmed) return 'URL is required'
  try {
    const u = new URL(trimmed)
    if (!['http:', 'https:'].includes(u.protocol)) return 'URL must start with http:// or https://'
  } catch {
    return 'Enter a valid URL, e.g. https://example.com/feed.rss'
  }
  if (existing.some((f) => f.url === trimmed)) return 'This feed is already in the list'
  return ''
}

function formatPreviewDate(dateStr: string): string {
  try {
    const mins = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000)
    if (mins < 60) return `${mins}m ago`
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

function parseOpml(text: string): Feed[] {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(text, 'text/xml')
    const outlines = Array.from(doc.querySelectorAll('outline[xmlUrl]'))
    return outlines
      .map((o) => {
        const url = o.getAttribute('xmlUrl')?.trim() ?? ''
        const name =
          (o.getAttribute('text') ?? o.getAttribute('title') ?? '').trim() ||
          autoName(url)
        return { url, name }
      })
      .filter((f) => {
        try { const u = new URL(f.url); return ['http:', 'https:'].includes(u.protocol) }
        catch { return false }
      })
  } catch { return [] }
}

export default function FeedEditor({ type, onClose, onSaved }: FeedEditorProps) {
  const label = type === 'lab' ? 'Tech / Lab' : 'Family'
  const accent = type === 'lab' ? 'text-orange-400' : 'text-amber-400'
  const accentBg = type === 'lab' ? 'bg-orange-500/10 border-orange-500/20' : 'bg-amber-500/10 border-amber-500/20'

  const [step, setStep] = useState<'loading' | 'auth' | 'edit'>('loading')
  const [secret, setSecret] = useState('')
  const [secretRemembered, setSecretRemembered] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  const [feeds, setFeeds] = useState<Feed[]>([])
  const [health, setHealth] = useState<Record<string, FeedHealth>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [addUrl, setAddUrl] = useState('')
  const [addName, setAddName] = useState('')
  const [urlError, setUrlError] = useState('')
  const [urlDirty, setUrlDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const urlInputRef = useRef<HTMLInputElement>(null)
  const secretInputRef = useRef<HTMLInputElement>(null)
  const opmlInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const cached = loadCachedSecret()
    if (cached) {
      setSecret(cached)
      setSecretRemembered(true)
      loadFeeds(cached)
    } else {
      setStep('auth')
    }
  }, [])

  useEffect(() => {
    if (step === 'auth') secretInputRef.current?.focus()
  }, [step])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function loadFeeds(s: string) {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`/api/feeds?type=${type}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setFeeds(data.feeds ?? [])
      setHealth(data.health ?? {})
      setStep('edit')
    } catch {
      setAuthError('Failed to load feeds — please try again')
      setStep('auth')
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault()
    loadFeeds(secret)
  }

  function handleRemove(index: number) {
    setFeeds((prev) => prev.filter((_, i) => i !== index))
    setSaveError('')
  }

  function handleMove(index: number, dir: -1 | 1) {
    setFeeds((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function handleUrlChange(val: string) {
    setAddUrl(val)
    setTestResult(null)
    if (urlDirty) setUrlError(validateUrl(val, feeds))
  }

  function handleUrlBlur() {
    setUrlDirty(true)
    const err = validateUrl(addUrl, feeds)
    setUrlError(err)
    if (!err && addUrl.trim() && !addName.trim()) {
      setAddName(autoName(addUrl.trim()))
    }
  }

  async function handleTestFeed() {
    const trimmedUrl = addUrl.trim()
    const err = validateUrl(trimmedUrl, feeds)
    if (err) { setUrlError(err); return }

    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`/api/feeds/test?url=${encodeURIComponent(trimmedUrl)}`)
      const data = await res.json() as TestResult
      setTestResult(data)
      if (data.ok && !addName.trim()) {
        setAddName(autoName(trimmedUrl))
      }
    } catch {
      setTestResult({ ok: false, error: 'Network error — check server logs' })
    } finally {
      setTesting(false)
    }
  }

  function handleAddFeed() {
    setUrlDirty(true)
    const trimmedUrl = addUrl.trim()
    const err = validateUrl(trimmedUrl, feeds)
    if (err) { setUrlError(err); urlInputRef.current?.focus(); return }
    if (feeds.length >= 15) { setUrlError('Maximum of 15 feeds reached'); return }
    const name = addName.trim() || autoName(trimmedUrl) || trimmedUrl
    setFeeds((prev) => [...prev, { url: trimmedUrl, name }])
    setAddUrl('')
    setAddName('')
    setUrlError('')
    setUrlDirty(false)
    setTestResult(null)
    setSaveError('')
    urlInputRef.current?.focus()
  }

  function handleAddKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); handleAddFeed() }
  }

  function handleOpmlImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result
      if (typeof text !== 'string') return
      const parsed = parseOpml(text)
      if (parsed.length === 0) {
        setImportMsg({ ok: false, text: 'No valid RSS feed entries found in OPML file' })
        return
      }
      let added = 0
      setFeeds((prev) => {
        const existingUrls = new Set(prev.map((f) => f.url))
        const newFeeds = parsed.filter((f) => !existingUrls.has(f.url))
        // Respect max 15
        const slots = Math.max(0, 15 - prev.length)
        const toAdd = newFeeds.slice(0, slots)
        added = toAdd.length
        const skipped = parsed.length - toAdd.length
        setImportMsg({
          ok: true,
          text: `Added ${added} feed${added !== 1 ? 's' : ''}${skipped > 0 ? ` (${skipped} skipped — duplicate or limit reached)` : ''}`,
        })
        return [...prev, ...toAdd]
      })
    }
    reader.readAsText(file)
    // Reset input so same file can be re-imported
    e.target.value = ''
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError('')
    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ type, feeds }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) {
          forgetSecret()
          setSecretRemembered(false)
          setSaveError('Incorrect secret — please re-enter')
          setStep('auth')
        } else {
          setSaveError(data.error ?? 'Save failed')
        }
        return
      }
      persistSecret(secret)
      onSaved()
      onClose()
    } catch {
      setSaveError('Save failed — please try again')
    } finally {
      setSaving(false)
    }
  }

  function handleForgetSecret() {
    forgetSecret()
    setSecretRemembered(false)
    setSecret('')
    setStep('auth')
  }

  function formatAge(iso: string): string {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (mins < 60) return `${mins}m ago`
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`
    return `${Math.round(mins / 1440)}d ago`
  }

  function HealthDot({ url }: { url: string }) {
    const h = health[url]
    if (!h) return <span className="w-2 h-2 rounded-full bg-zinc-700 flex-shrink-0" title="Never checked" />

    if (h.ok) {
      const slow = h.fetchDurationMs !== undefined && h.fetchDurationMs > 5000
      return (
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${slow ? 'bg-yellow-400/80' : 'bg-emerald-500/80'}`}
          title={[
            slow ? `Slow (${(h.fetchDurationMs! / 1000).toFixed(1)}s)` : `OK`,
            `${h.itemCount ?? '?'} items`,
            `checked ${formatAge(h.checkedAt)}`,
          ].join(' · ')}
        />
      )
    }

    // Failed — show how long it's been dead
    const lastOkText = h.lastSuccess
      ? `last ok ${formatAge(h.lastSuccess)}`
      : 'never succeeded'
    return (
      <span
        className="w-2 h-2 rounded-full bg-red-500/80 flex-shrink-0"
        title={`Failed: ${h.error ?? 'unknown error'} · ${lastOkText}`}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      aria-modal="true"
      role="dialog"
      aria-label={`Manage ${label} Feeds`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white">Manage Feeds</h2>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${accentBg} ${accent}`}>
                {label}
              </span>
            </div>
            <p className="text-xs text-zinc-500 mt-0.5">Add, remove, or reorder RSS / Atom feeds</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors text-xl leading-none p-1 -mr-1 rounded"
            aria-label="Close"
          >✕</button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">

          {step === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
            </div>
          )}

          {step === 'auth' && (
            <form onSubmit={handleAuth} className="space-y-4">
              <p className="text-sm text-zinc-400">Enter your admin secret to manage feeds.</p>
              <input
                ref={secretInputRef}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Admin secret"
                autoComplete="current-password"
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
              />
              <p className="text-xs text-zinc-600">Your secret will be remembered for 24 hours.</p>
              {authError && <p className="text-sm text-red-400">{authError}</p>}
              <button
                type="submit"
                disabled={authLoading || !secret.trim()}
                className="w-full py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {authLoading ? 'Loading…' : 'Continue'}
              </button>
            </form>
          )}

          {step === 'edit' && (
            <form onSubmit={handleSave} className="space-y-5">

              {/* Dead / slow feed warnings */}
              {(() => {
                const deadFeeds = feeds.filter((f) => {
                  const h = health[f.url]
                  if (!h) return false
                  if (h.ok) return false
                  // Consider dead if failed and hasn't succeeded in 2+ hours (or never)
                  if (!h.lastSuccess) return true
                  const ageH = (Date.now() - new Date(h.lastSuccess).getTime()) / 3600000
                  return ageH >= 2
                })
                const slowFeeds = feeds.filter((f) => {
                  const h = health[f.url]
                  return h?.ok && h.fetchDurationMs !== undefined && h.fetchDurationMs > 5000
                })
                if (deadFeeds.length === 0 && slowFeeds.length === 0) return null
                return (
                  <div className="rounded-lg px-3 py-2.5 border bg-red-500/5 border-red-500/20 text-xs space-y-1 mb-1">
                    {deadFeeds.length > 0 && (
                      <div className="text-red-400">
                        <span className="font-semibold">Dead: </span>
                        {deadFeeds.map((f) => {
                          const h = health[f.url]
                          const since = h?.lastSuccess ? ` (last ok ${formatAge(h.lastSuccess)})` : ' (never succeeded)'
                          return (
                            <span key={f.url} className="mr-2">{f.name}{since}</span>
                          )
                        })}
                      </div>
                    )}
                    {slowFeeds.length > 0 && (
                      <div className="text-yellow-400">
                        <span className="font-semibold">Slow (&gt;5s): </span>
                        {slowFeeds.map((f) => {
                          const ms = health[f.url]?.fetchDurationMs ?? 0
                          return (
                            <span key={f.url} className="mr-2">{f.name} ({(ms / 1000).toFixed(1)}s)</span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Current feeds */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    Active feeds
                  </span>
                  <div className="flex items-center gap-3">
                    {secretRemembered && (
                      <button
                        type="button"
                        onClick={handleForgetSecret}
                        className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                      >
                        forget secret
                      </button>
                    )}
                    {/* OPML export */}
                    <a
                      href={`/api/feeds/opml?type=${type}`}
                      download
                      className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                      title="Export as OPML"
                    >
                      export OPML
                    </a>
                    <span className="text-xs text-zinc-600">{feeds.length} / 15</span>
                  </div>
                </div>

                {feeds.length === 0 ? (
                  <div className="text-sm text-zinc-500 italic py-3 text-center border border-dashed border-zinc-800 rounded-lg">
                    No feeds — add one below
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {feeds.map((feed, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-800 hover:border-zinc-700 transition-colors"
                      >
                        {/* Reorder buttons */}
                        <div className="flex flex-col gap-0.5 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => handleMove(i, -1)}
                            disabled={i === 0}
                            className="text-zinc-700 hover:text-zinc-400 disabled:opacity-20 text-[10px] leading-none transition-colors"
                            title="Move up"
                          >▲</button>
                          <button
                            type="button"
                            onClick={() => handleMove(i, 1)}
                            disabled={i === feeds.length - 1}
                            className="text-zinc-700 hover:text-zinc-400 disabled:opacity-20 text-[10px] leading-none transition-colors"
                            title="Move down"
                          >▼</button>
                        </div>

                        {/* Health dot */}
                        <HealthDot url={feed.url} />

                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-zinc-200 truncate">{feed.name}</div>
                          <div className="text-xs text-zinc-500 truncate mt-0.5">{feed.url}</div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemove(i)}
                          disabled={feeds.length <= 1}
                          title={feeds.length <= 1 ? 'At least one feed is required' : `Remove "${feed.name}"`}
                          aria-label={`Remove ${feed.name}`}
                          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-25 disabled:cursor-not-allowed text-sm"
                        >✕</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Add feed */}
              <div className="border-t border-zinc-800 pt-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Add a feed</span>
                  {/* OPML import */}
                  <div>
                    <input
                      ref={opmlInputRef}
                      type="file"
                      accept=".opml,.xml"
                      className="hidden"
                      onChange={handleOpmlImport}
                    />
                    <button
                      type="button"
                      onClick={() => { setImportMsg(null); opmlInputRef.current?.click() }}
                      disabled={feeds.length >= 15}
                      className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40"
                      title="Import feeds from OPML file"
                    >
                      import OPML
                    </button>
                  </div>
                </div>

                {importMsg && (
                  <div className={`rounded-lg px-3 py-2 border text-xs mb-3 ${
                    importMsg.ok
                      ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
                      : 'bg-amber-500/5 border-amber-500/20 text-amber-400'
                  }`}>
                    {importMsg.text}
                  </div>
                )}

                <div className="space-y-2">
                  <div>
                    <div className="flex gap-2">
                      <input
                        ref={urlInputRef}
                        type="url"
                        value={addUrl}
                        onChange={(e) => handleUrlChange(e.target.value)}
                        onBlur={handleUrlBlur}
                        onKeyDown={handleAddKeyDown}
                        placeholder="https://example.com/feed.rss"
                        autoComplete="off"
                        className={`flex-1 px-3 py-2 rounded-lg bg-zinc-800 border text-sm text-white placeholder-zinc-500 focus:outline-none transition-colors ${
                          urlError ? 'border-red-500/60 focus:border-red-500' : 'border-zinc-700 focus:border-zinc-500'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={handleTestFeed}
                        disabled={testing || !addUrl.trim()}
                        className="px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 text-xs font-medium transition-colors disabled:opacity-40 flex-shrink-0"
                        title="Test this feed URL"
                      >
                        {testing ? '…' : 'Test'}
                      </button>
                    </div>
                    {urlError && (
                      <p className="text-xs text-red-400 mt-1.5 flex items-center gap-1">
                        <span aria-hidden>⚠</span> {urlError}
                      </p>
                    )}
                  </div>

                  {/* Test result */}
                  {testResult && (
                    <div className={`rounded-lg px-3 py-2.5 border text-xs ${
                      testResult.ok
                        ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
                        : 'bg-red-500/5 border-red-500/20 text-red-400'
                    }`}>
                      {testResult.ok ? (
                        <div>
                          <div className="font-semibold mb-1">✓ Valid feed — {testResult.itemCount} items found</div>
                          {testResult.preview?.map((p, i) => (
                            <div key={i} className="text-emerald-500/70 truncate">
                              · {p.title} <span className="opacity-60">({formatPreviewDate(p.pubDate)})</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div>⚠ {testResult.error}</div>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      onKeyDown={handleAddKeyDown}
                      placeholder="Display name (auto-filled from URL)"
                      maxLength={60}
                      className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={handleAddFeed}
                      disabled={!addUrl.trim() || feeds.length >= 15}
                      title={feeds.length >= 15 ? 'Maximum 15 feeds reached' : 'Add feed'}
                      className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors disabled:opacity-40 flex-shrink-0"
                    >+ Add</button>
                  </div>
                </div>
              </div>

              {saveError && <p className="text-sm text-red-400">{saveError}</p>}

              <div className="flex gap-2 pt-1 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white text-sm transition-colors"
                >Cancel</button>
                <button
                  type="submit"
                  disabled={saving || feeds.length === 0}
                  className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >{saving ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
