'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import QuickLinkEditor from '@/components/shared/QuickLinkEditor'
import type { QuickLink } from '@/lib/config'

const ICON_EMOJI: Record<string, string> = {
  photos: '🖼️', immich: '🖼️',
  gmail: '✉️',
  prime: '📦', netflix: '🎬', youtube: '▶️', disney: '🏰',
  amp: '🎮', games: '🎮',
  adguard: '🛡️',
  proxmox: '🖥️',
  portainer: '🐳',
  grafana: '📊',
  traefik: '🔀',
  'uptime-kuma': '📡', uptime: '📡',
  calibre: '📚',
  audiobookshelf: '🎧',
  changedetect: '🔔',
  shelfmark: '🏷️',
  grocy: '🛒',
  homeassistant: '🏠',
  webmin: '⚙️',
}

const DEFAULT_COLOR = '#71717a'

interface ContextMenu {
  x: number
  y: number
  link: QuickLink
  section: 'home' | 'lab'
  index: number
}

interface EditorState {
  section: 'home' | 'lab'
  editLink?: { link: QuickLink; index: number }
}

export default function QuickLinksDropdown() {
  const [open, setOpen] = useState(false)
  const [links, setLinks] = useState<{ home: QuickLink[]; lab: QuickLink[] }>({ home: [], lab: [] })
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/quicklinks').then((r) => r.json()).then(setLinks).catch(() => {})
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return
    const onClick = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  function positionMenu(e: React.MouseEvent, menuHeight: number): { x: number; y: number } {
    const x = Math.min(e.clientX, window.innerWidth - 185)
    const y = e.clientY + menuHeight > window.innerHeight
      ? e.clientY - menuHeight
      : e.clientY
    return { x, y }
  }

  function handleContextMenu(e: React.MouseEvent, link: QuickLink, section: 'home' | 'lab', index: number) {
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = positionMenu(e, 130)
    setCtxMenu({ x, y, link, section, index })
  }

  function handleGroupContextMenu(e: React.MouseEvent, section: 'home' | 'lab') {
    e.preventDefault()
    const { x, y } = positionMenu(e, 60)
    setCtxMenu({ x, y, link: { name: '', url: '' }, section, index: -1 })
  }

  function openEditor(section: 'home' | 'lab', editLink?: { link: QuickLink; index: number }) {
    setCtxMenu(null)
    setEditor({ section, editLink })
  }

  function handleSaved(section: 'home' | 'lab', updated: QuickLink[]) {
    setLinks((prev) => ({ ...prev, [section]: updated }))
  }

  const groups: { label: string; section: 'home' | 'lab'; items: QuickLink[] }[] = [
    { label: 'Home', section: 'home' as const, items: links.home },
    { label: 'Lab', section: 'lab' as const, items: links.lab },
  ]

  return (
    <>
      {editor && (
        <QuickLinkEditor
          section={editor.section}
          existingLinks={links[editor.section]}
          editLink={editor.editLink}
          onClose={() => setEditor(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Context menu — portalled to body to escape header backdrop-filter containing block */}
      {ctxMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={ctxRef}
          className="fixed rounded-lg border shadow-2xl overflow-hidden"
          style={{
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 99999,
            background: 'rgba(14,14,16,0.98)',
            borderColor: 'rgba(255,255,255,0.1)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            minWidth: '160px',
          }}
        >
          {ctxMenu.index >= 0 && (
            <>
              <div className="px-3 py-2 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <p className="text-[11px] text-zinc-400 font-medium truncate max-w-[140px]">{ctxMenu.link.name}</p>
              </div>
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/5 hover:text-white transition-colors text-left"
                onClick={() => openEditor(ctxMenu.section, { link: ctxMenu.link, index: ctxMenu.index })}
              >
                <span className="text-base">✏️</span> Edit
              </button>
              <div className="border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }} />
            </>
          )}
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/5 hover:text-white transition-colors text-left"
            onClick={() => openEditor(ctxMenu.section)}
          >
            <span className="text-base">➕</span> Add link
          </button>
        </div>,
        document.body
      )}

      <div ref={dropdownRef} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all duration-200 select-none"
          style={{
            background: open ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: open ? '#e4e4e7' : '#71717a',
          }}
        >
          <span>🔗</span>
          <span>Quick Links</span>
          <span style={{ fontSize: '9px', opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
        </button>

        {open && (
          <div
            className="absolute right-0 top-full mt-2 rounded-xl border"
            style={{
              zIndex: 9999,
              background: 'rgba(14,14,16,0.98)',
              backdropFilter: 'blur(20px)',
              borderColor: 'rgba(255,255,255,0.08)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
              width: '240px',
              maxHeight: '72vh',
              overflowY: 'auto',
            }}
          >
            {groups.map((group, gi) => (
              <div key={group.label}>
                {/* Group header — right-click to add */}
                <div
                  className="flex items-center justify-between px-3 py-2 cursor-default select-none"
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    borderTop: gi > 0 ? '1px solid rgba(255,255,255,0.07)' : undefined,
                    background: 'rgba(255,255,255,0.02)',
                  }}
                  onContextMenu={(e) => handleGroupContextMenu(e, group.section)}
                >
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{group.label}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); openEditor(group.section) }}
                    className="text-zinc-700 hover:text-zinc-400 text-xs transition-colors leading-none"
                    title={`Add ${group.label} link`}
                  >＋</button>
                </div>

                {group.items.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-zinc-700 italic">No links — right-click to add</div>
                ) : (
                  group.items.map((link, i) => {
                    const color = link.color ?? DEFAULT_COLOR
                    const emoji = link.icon ? (ICON_EMOJI[link.icon] ?? null) : null
                    return (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setOpen(false)}
                        onContextMenu={(e) => handleContextMenu(e, link, group.section, i)}
                        className="flex items-center gap-3 px-3 py-2 no-underline group transition-colors"
                        style={{ borderLeft: `2px solid ${color}40` }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.background = `${color}12`
                          ;(e.currentTarget as HTMLElement).style.borderLeftColor = color
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background = ''
                          ;(e.currentTarget as HTMLElement).style.borderLeftColor = `${color}40`
                        }}
                      >
                        {emoji ? (
                          <span className="text-sm flex-shrink-0 w-5 text-center">{emoji}</span>
                        ) : (
                          <span
                            className="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center text-[10px] font-bold"
                            style={{ background: `${color}22`, color }}
                          >
                            {link.name[0]}
                          </span>
                        )}
                        <span className="flex-1 text-sm text-zinc-300 group-hover:text-white transition-colors truncate">
                          {link.name}
                        </span>
                        <span className="text-zinc-700 group-hover:text-zinc-400 text-xs transition-colors flex-shrink-0">↗</span>
                      </a>
                    )
                  })
                )}
              </div>
            ))}

            {/* Footer hint */}
            <div className="px-3 py-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
              <p className="text-[10px] text-zinc-700">Right-click any link to edit or remove</p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
