'use client'

import { useState, useRef, useEffect } from 'react'

interface Dashboard {
  title: string
  path: string
}

interface HADashboardEditorProps {
  onClose: () => void
  onSaved: () => void
}

export default function HADashboardEditor({ onClose, onSaved }: HADashboardEditorProps) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editPath, setEditPath] = useState('')

  const [addPath, setAddPath] = useState('')
  const [addTitle, setAddTitle] = useState('')
  const [pathError, setPathError] = useState('')

  const pathInputRef = useRef<HTMLInputElement>(null)
  const editTitleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/homeassistant/dashboards')
      .then((r) => r.json())
      .then((data) => setDashboards(data.dashboards ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { if (editingIndex !== null) { setEditingIndex(null) } else { onClose() } } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editingIndex])

  useEffect(() => {
    if (editingIndex !== null) editTitleRef.current?.focus()
  }, [editingIndex])

  function handleRemove(index: number) {
    setDashboards((prev) => prev.filter((_, i) => i !== index))
    if (editingIndex === index) setEditingIndex(null)
    setSaveError('')
  }

  function startEdit(index: number) {
    setEditingIndex(index)
    setEditTitle(dashboards[index].title)
    setEditPath(dashboards[index].path)
  }

  function commitEdit() {
    if (editingIndex === null) return
    const title = editTitle.trim()
    const path = editPath.trim()
    if (!title || !path) return
    setDashboards((prev) =>
      prev.map((d, i) => (i === editingIndex ? { title, path } : d))
    )
    setEditingIndex(null)
    setSaveError('')
  }

  function handleAdd() {
    const trimmedPath = addPath.trim()
    if (!trimmedPath) { setPathError('Path is required'); return }
    if (!trimmedPath.startsWith('/')) { setPathError('Path must start with /'); return }
    if (dashboards.some((d) => d.path === trimmedPath)) { setPathError('This path already exists'); return }

    const title = addTitle.trim() || trimmedPath.split('/').filter(Boolean)[0] || 'Dashboard'
    setDashboards((prev) => [...prev, { title, path: trimmedPath }])
    setAddPath('')
    setAddTitle('')
    setPathError('')
    setSaveError('')
    pathInputRef.current?.focus()
  }

  function handleAddKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); handleAdd() }
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (editingIndex !== null) commitEdit()
    setSaving(true)
    setSaveError('')
    try {
      const res = await fetch('/api/homeassistant/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboards }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setSaveError(data.error ?? 'Save failed')
        return
      }
      onSaved()
      onClose()
    } catch {
      setSaveError('Save failed — please try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      aria-modal="true"
      role="dialog"
      aria-label="Manage HA Dashboards"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white">Manage Dashboards</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Add, edit, or remove Home Assistant dashboards</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors text-xl leading-none p-1 -mr-1 rounded"
            aria-label="Close"
          >✕</button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-5">

              {/* Current dashboards */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Dashboards</span>
                  <span className="text-xs text-zinc-600">{dashboards.length} / 20</span>
                </div>

                {dashboards.length === 0 ? (
                  <div className="text-sm text-zinc-500 italic py-3 text-center border border-dashed border-zinc-800 rounded-lg">
                    No dashboards — add one below
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {dashboards.map((d, i) => (
                      <li
                        key={i}
                        className="px-3 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-800 hover:border-zinc-700 transition-colors"
                      >
                        {editingIndex === i ? (
                          /* Inline edit mode */
                          <div className="space-y-2">
                            <input
                              ref={editTitleRef}
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              placeholder="Display name"
                              maxLength={60}
                              className="w-full px-2 py-1.5 rounded bg-zinc-700 border border-zinc-600 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
                            />
                            <input
                              type="text"
                              value={editPath}
                              onChange={(e) => setEditPath(e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              placeholder="/dashboard-name/0"
                              className="w-full px-2 py-1.5 rounded bg-zinc-700 border border-zinc-600 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={commitEdit}
                                disabled={!editTitle.trim() || !editPath.trim()}
                                className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors disabled:opacity-40"
                              >Done</button>
                              <button
                                type="button"
                                onClick={() => setEditingIndex(null)}
                                className="px-3 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-white text-xs transition-colors"
                              >Cancel</button>
                            </div>
                          </div>
                        ) : (
                          /* Display mode */
                          <div className="flex items-center gap-3">
                            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => startEdit(i)}>
                              <div className="text-sm font-medium text-zinc-200 truncate">{d.title}</div>
                              <div className="text-xs text-zinc-500 truncate mt-0.5">{d.path}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => startEdit(i)}
                              title={`Edit "${d.title}"`}
                              aria-label={`Edit ${d.title}`}
                              className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-zinc-600 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                                <path d="M13.488 2.513a1.75 1.75 0 00-2.475 0L3.22 10.303a1 1 0 00-.26.443l-.97 3.516a.75.75 0 00.927.927l3.516-.97a1 1 0 00.443-.26l7.79-7.793a1.75 1.75 0 000-2.475l-.178-.178zM11.19 3.56l1.25 1.25-6.85 6.85-1.625.45.449-1.626 6.776-6.924z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemove(i)}
                              disabled={dashboards.length <= 1}
                              title={dashboards.length <= 1 ? 'At least one dashboard is required' : `Remove "${d.title}"`}
                              aria-label={`Remove ${d.title}`}
                              className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
                            >✕</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Add dashboard */}
              <div className="border-t border-zinc-800 pt-5">
                <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Add a dashboard</div>
                <div className="space-y-2">
                  <div>
                    <input
                      ref={pathInputRef}
                      type="text"
                      value={addPath}
                      onChange={(e) => { setAddPath(e.target.value); setPathError('') }}
                      onKeyDown={handleAddKeyDown}
                      placeholder="/dashboard-name/0"
                      autoComplete="off"
                      className={`w-full px-3 py-2 rounded-lg bg-zinc-800 border text-sm text-white placeholder-zinc-500 focus:outline-none transition-colors ${
                        pathError ? 'border-red-500/60 focus:border-red-500' : 'border-zinc-700 focus:border-zinc-500'
                      }`}
                    />
                    {pathError && (
                      <p className="text-xs text-red-400 mt-1.5 flex items-center gap-1">
                        <span aria-hidden>!</span> {pathError}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={addTitle}
                      onChange={(e) => setAddTitle(e.target.value)}
                      onKeyDown={handleAddKeyDown}
                      placeholder="Display name"
                      maxLength={60}
                      className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={handleAdd}
                      disabled={!addPath.trim() || dashboards.length >= 20}
                      className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors disabled:opacity-40 flex-shrink-0"
                    >+ Add</button>
                  </div>
                </div>
              </div>

              {saveError && <p className="text-sm text-red-400">{saveError}</p>}

              {/* Actions */}
              <div className="flex gap-2 pt-1 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white text-sm transition-colors"
                >Cancel</button>
                <button
                  type="submit"
                  disabled={saving || dashboards.length === 0}
                  className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >{saving ? 'Saving...' : 'Save Changes'}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
