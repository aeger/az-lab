'use client'

import { useState } from 'react'
import type { Message, MessageSeverity } from '@/lib/message'

interface MessageEditorProps {
  onClose: () => void
  onSaved: (msg: Message) => void
}

export default function MessageEditor({ onClose, onSaved }: MessageEditorProps) {
  const [step, setStep] = useState<'auth' | 'edit'>('auth')
  const [secret, setSecret] = useState('')
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(false)

  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<MessageSeverity>('info')
  const [enabled, setEnabled] = useState(true)

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setAuthError('')

    // Verify by trying to GET the current message (always succeeds)
    // Then load existing message
    try {
      const res = await fetch('/api/message')
      const msg = await res.json() as Message
      setText(msg.text)
      setTitle(msg.title)
      setSeverity(msg.severity)
      setEnabled(msg.enabled)
      setStep('edit')
    } catch {
      setAuthError('Failed to load message')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      const res = await fetch('/api/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({ text, title, severity, enabled }),
      })

      if (!res.ok) {
        setAuthError('Wrong secret or save failed')
        return
      }

      const saved = await res.json() as Message
      onSaved(saved)
      onClose()
    } catch {
      setAuthError('Save failed')
    } finally {
      setLoading(false)
    }
  }

  const severityOptions: { value: MessageSeverity; label: string; color: string }[] = [
    { value: 'info', label: 'Info', color: 'text-blue-400' },
    { value: 'success', label: 'Success', color: 'text-emerald-400' },
    { value: 'warning', label: 'Warning', color: 'text-amber-400' },
    { value: 'alert', label: 'Alert', color: 'text-red-400' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Message Editor</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white text-xl">✕</button>
        </div>

        {step === 'auth' && (
          <form onSubmit={handleAuth} className="space-y-4">
            <p className="text-sm text-zinc-400">Enter your admin secret to edit the message.</p>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Admin secret"
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
              autoFocus
            />
            {authError && <p className="text-sm text-red-400">{authError}</p>}
            <button
              type="submit"
              disabled={loading || !secret}
              className="w-full py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Continue'}
            </button>
          </form>
        )}

        {step === 'edit' && (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="flex items-center gap-3">
              <label className="text-sm text-zinc-400 w-16">Enabled</label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-zinc-700'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
              </button>
            </div>

            <div>
              <label className="text-sm text-zinc-400 block mb-1">Title (optional)</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Maintenance Tonight"
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div>
              <label className="text-sm text-zinc-400 block mb-1">Message</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Internet will be down for maintenance tonight 9–10pm."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 resize-none"
              />
            </div>

            <div>
              <label className="text-sm text-zinc-400 block mb-1">Severity</label>
              <div className="flex gap-2">
                {severityOptions.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setSeverity(s.value)}
                    className={`flex-1 py-1.5 rounded-lg border text-sm font-medium transition-colors ${severity === s.value ? 'border-zinc-500 bg-zinc-700' : 'border-zinc-700 bg-zinc-800'} ${s.color}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {authError && <p className="text-sm text-red-400">{authError}</p>}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
