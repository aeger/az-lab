'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { SOUND_CATALOG, DEFAULT_SOUND_SETTINGS, getSoundEngine } from '@/lib/soundEngine'
import type { SoundSettings as SoundSettingsType, UrgencySoundConfig } from '@/lib/soundEngine'

const STORAGE_KEY = 'sentinel-sound-settings'
const URGENCIES = ['critical', 'high', 'medium', 'low'] as const
type Urgency = typeof URGENCIES[number]

const URGENCY_COLOR: Record<Urgency, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#71717a',
}

const URGENCY_BG: Record<Urgency, string> = {
  critical: 'rgba(239,68,68,0.12)',
  high: 'rgba(249,115,22,0.12)',
  medium: 'rgba(234,179,8,0.12)',
  low: 'rgba(113,113,122,0.10)',
}

function loadSettings(): SoundSettingsType {
  if (typeof window === 'undefined') return { ...DEFAULT_SOUND_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_SOUND_SETTINGS, ...parsed }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SOUND_SETTINGS }
}

function saveSettings(s: SoundSettingsType): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch { /* ignore */ }
}

async function syncToSupabase(s: SoundSettingsType): Promise<void> {
  try {
    await fetch('/api/sound-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: s }),
    })
  } catch { /* ignore — Supabase sync is best-effort */ }
}

async function loadFromSupabase(): Promise<SoundSettingsType | null> {
  try {
    const res = await fetch('/api/sound-preferences', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      if (data.ok && data.settings) {
        return { ...DEFAULT_SOUND_SETTINGS, ...data.settings } as SoundSettingsType
      }
    }
  } catch { /* ignore */ }
  return null
}

export function useSoundSettings() {
  const [settings, setSettings] = useState<SoundSettingsType>(DEFAULT_SOUND_SETTINGS)
  const initialized = useRef(false)

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      // Try Supabase first, fall back to localStorage
      loadFromSupabase().then(remote => {
        const s = remote || loadSettings()
        setSettings(s)
        saveSettings(s) // keep localStorage in sync
      })
    }
  }, [])

  const update = useCallback((next: SoundSettingsType) => {
    setSettings(next)
    saveSettings(next)
    syncToSupabase(next) // best-effort Supabase sync
  }, [])

  return { settings, update }
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function SoundSettings({ open, onClose }: Props) {
  const { settings, update } = useSoundSettings()
  const [local, setLocal] = useState<SoundSettingsType>(settings)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [customSounds, setCustomSounds] = useState<{ id: string; name: string }[]>([])

  // Sync local from settings when panel opens
  useEffect(() => {
    if (open) setLocal(loadSettings())
  }, [open])

  // IndexedDB helpers
  const openDB = (): Promise<IDBDatabase> =>
    new Promise((res, rej) => {
      const req = indexedDB.open('sentinel-sounds', 1)
      req.onupgradeneeded = (e) => (e.target as IDBOpenDBRequest).result.createObjectStore('custom-sounds', { keyPath: 'id' })
      req.onsuccess = (e) => res((e.target as IDBOpenDBRequest).result)
      req.onerror = () => rej(req.error)
    })

  const loadCustomSounds = useCallback(async () => {
    const db = await openDB()
    const tx = db.transaction('custom-sounds', 'readonly')
    const req = tx.objectStore('custom-sounds').getAll()
    req.onsuccess = (e) => {
      const records = (e.target as IDBRequest).result as { id: string; name: string }[]
      setCustomSounds(records.map(r => ({ id: r.id, name: r.name })))
    }
  }, [])

  useEffect(() => {
    if (open) loadCustomSounds()
  }, [open, loadCustomSounds])

  const deleteCustomSound = async (id: string) => {
    const db = await openDB()
    const tx = db.transaction('custom-sounds', 'readwrite')
    tx.objectStore('custom-sounds').delete(id)
    tx.oncomplete = () => loadCustomSounds()
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.match(/\.(mp3|wav)$/i)) {
      alert('Only .mp3 and .wav files are supported.')
      return
    }
    const arrayBuffer = await file.arrayBuffer()
    const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const name = file.name.replace(/\.(mp3|wav)$/i, '')
    const db = await openDB()
    const tx = db.transaction('custom-sounds', 'readwrite')
    tx.objectStore('custom-sounds').put({ id, name, data: arrayBuffer })
    tx.oncomplete = () => {
      loadCustomSounds()
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const setUrgencyField = <K extends keyof UrgencySoundConfig>(
    urgency: Urgency,
    field: K,
    value: UrgencySoundConfig[K]
  ) => {
    setLocal(prev => ({
      ...prev,
      [urgency]: { ...prev[urgency], [field]: value },
    }))
  }

  const handleSave = () => {
    update(local)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const previewSound = (soundId: string, volume: number) => {
    if (soundId.startsWith('custom:')) {
      const customId = soundId.slice(7)
      openDB().then(db => {
        const tx = db.transaction('custom-sounds', 'readonly')
        const req = tx.objectStore('custom-sounds').get(customId)
        req.onsuccess = async (e) => {
          const record = (e.target as IDBRequest).result
          if (record?.data) {
            await getSoundEngine().playBuffer(record.data, volume)
          }
        }
      })
    } else {
      getSoundEngine().play(soundId, volume)
    }
  }

  if (!open) return null

  const byCategory = SOUND_CATALOG.reduce((acc, s) => {
    if (!acc[s.category]) acc[s.category] = []
    acc[s.category].push(s)
    return acc
  }, {} as Record<string, typeof SOUND_CATALOG>)

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 99999, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-xl border overflow-hidden flex flex-col"
        style={{
          width: '500px',
          maxHeight: '85vh',
          background: '#0d0f14',
          borderColor: 'rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div className="flex items-center gap-2">
            <span style={{ fontSize: '16px' }}>🔊</span>
            <span className="text-sm font-semibold text-zinc-200">Sound Settings</span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-zinc-300 transition-colors text-sm"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Per-urgency rows */}
          <div className="px-5 pt-4 pb-2">
            <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-3">Alert Sounds</p>
            <div className="flex flex-col gap-3">
              {URGENCIES.map(urgency => {
                const cfg = local[urgency]
                const volPct = Math.round(cfg.volume * 100)
                return (
                  <div
                    key={urgency}
                    className="rounded-lg p-3"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      {/* Urgency label */}
                      <span
                        className="text-[10px] font-bold px-2 py-0.5 rounded"
                        style={{ background: URGENCY_BG[urgency], color: URGENCY_COLOR[urgency], minWidth: '52px', textAlign: 'center' }}
                      >
                        {urgency.toUpperCase()}
                      </span>
                      {/* Enable toggle */}
                      <label className="relative inline-flex items-center cursor-pointer ml-auto">
                        <input
                          type="checkbox"
                          checked={cfg.enabled}
                          onChange={e => setUrgencyField(urgency, 'enabled', e.target.checked)}
                          className="sr-only"
                        />
                        <div
                          className="w-8 h-4 rounded-full transition-colors relative"
                          style={{ background: cfg.enabled ? '#3b82f6' : '#2a2d36' }}
                        >
                          <div
                            className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
                            style={{ transform: cfg.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                          />
                        </div>
                      </label>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      {/* Sound selector */}
                      <select
                        value={cfg.sound}
                        onChange={e => setUrgencyField(urgency, 'sound', e.target.value)}
                        disabled={!cfg.enabled}
                        className="flex-1 rounded text-xs px-2 py-1.5 outline-none transition-colors"
                        style={{
                          background: '#0a0c10',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: cfg.enabled ? '#e2e8f0' : '#4a4d58',
                          cursor: cfg.enabled ? 'pointer' : 'not-allowed',
                        }}
                      >
                        {Object.entries(byCategory).map(([cat, sounds]) => (
                          <optgroup key={cat} label={cat.toUpperCase()}>
                            {sounds.map(s => (
                              <option key={s.id} value={s.id}>{s.label}</option>
                            ))}
                          </optgroup>
                        ))}
                        {customSounds.length > 0 && (
                          <optgroup label="CUSTOM">
                            {customSounds.map(cs => (
                              <option key={cs.id} value={`custom:${cs.id}`}>⭐ {cs.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      {/* Preview */}
                      <button
                        onClick={() => previewSound(cfg.sound, cfg.volume)}
                        disabled={!cfg.enabled}
                        className="px-2 py-1.5 rounded text-xs transition-colors"
                        style={{
                          background: 'transparent',
                          border: '1px solid rgba(255,255,255,0.1)',
                          color: cfg.enabled ? '#94a3b8' : '#3a3d48',
                          cursor: cfg.enabled ? 'pointer' : 'not-allowed',
                        }}
                      >
                        ▶ Test
                      </button>
                      {/* TTS (critical only) */}
                      {urgency === 'critical' && (
                        <button
                          onClick={() => setUrgencyField('critical', 'tts', !cfg.tts)}
                          className="px-2 py-1.5 rounded text-[10px] font-medium transition-colors"
                          style={{
                            background: 'transparent',
                            border: `1px solid ${cfg.tts ? '#3b82f6' : 'rgba(255,255,255,0.08)'}`,
                            color: cfg.tts ? '#3b82f6' : '#52555f',
                            cursor: 'pointer',
                          }}
                          title="Speak notification title via TTS on critical alert"
                        >
                          TTS
                        </button>
                      )}
                    </div>
                    {/* Volume */}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-700 w-10">Vol</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={volPct}
                        disabled={!cfg.enabled}
                        onChange={e => setUrgencyField(urgency, 'volume', parseInt(e.target.value, 10) / 100)}
                        className="flex-1"
                        style={{ cursor: cfg.enabled ? 'pointer' : 'not-allowed' }}
                      />
                      <span className="text-[10px] text-zinc-600 w-8 text-right">{volPct}%</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Custom sounds upload */}
          <div className="px-5 pt-4 pb-5">
            <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-3">Custom Sounds</p>
            <label
              htmlFor="sound-upload"
              className="flex flex-col items-center justify-center rounded-lg p-4 cursor-pointer transition-colors mb-3"
              style={{
                border: '1px dashed rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.01)',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.4)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
            >
              <span className="text-xs text-zinc-500 mb-1">Upload .mp3 or .wav</span>
              <span className="text-[10px] text-zinc-700">Stored in browser (IndexedDB)</span>
            </label>
            <input
              ref={fileRef}
              id="sound-upload"
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              onChange={handleFileUpload}
              className="hidden"
            />
            {customSounds.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {customSounds.map(cs => (
                  <div
                    key={cs.id}
                    className="flex items-center gap-2 px-3 py-2 rounded"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <span className="flex-1 text-xs text-zinc-400 truncate">{cs.name}</span>
                    <button
                      onClick={() => previewSound(`custom:${cs.id}`, 0.7)}
                      className="text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors px-1.5 py-0.5 rounded"
                      style={{ border: '1px solid rgba(255,255,255,0.07)' }}
                    >
                      ▶
                    </button>
                    <button
                      onClick={() => deleteCustomSound(cs.id)}
                      className="text-[10px] text-zinc-700 hover:text-red-400 transition-colors px-1.5 py-0.5 rounded"
                      style={{ border: '1px solid rgba(255,0,0,0.1)' }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <button
            onClick={onClose}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Cancel
          </button>
          <div className="flex items-center gap-3">
            {saved && (
              <span className="text-xs text-green-500">Saved ✓</span>
            )}
            <button
              onClick={handleSave}
              className="px-4 py-1.5 rounded text-xs font-semibold transition-colors"
              style={{ background: '#3b82f6', color: '#fff' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#2563eb')}
              onMouseLeave={e => (e.currentTarget.style.background = '#3b82f6')}
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
