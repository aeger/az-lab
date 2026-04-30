'use client'

import { useEffect, useState } from 'react'
import FeedEditor from '@/components/shared/FeedEditor'

interface NewsItem {
  title: string
  link: string
  pubDate: string
  source: string
  summary?: string
  imageUrl?: string
}

export default function NewsWidget() {
  const [items, setItems] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showEditor, setShowEditor] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/news?type=family')
      const d = await res.json()
      setItems(d.items ?? [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [reloadKey])

  function handleExpand(link: string) {
    setExpanded((prev) => (prev === link ? null : link))
  }

  return (
    <>
      {showEditor && (
        <FeedEditor
          type="family"
          onClose={() => setShowEditor(false)}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}

      <div>
        <div className="flex justify-end mb-2 gap-3">
          <button onClick={() => setShowEditor(true)} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            edit feeds
          </button>
          <button onClick={load} disabled={loading} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40">
            refresh
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-zinc-500 text-sm text-center py-8">No news available</div>
        ) : (
          <ul className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {items.map((item, i) => {
              const isExpanded = expanded === item.link
              return (
                <li key={i} className={`rounded-lg border transition-all ${isExpanded ? 'border-zinc-700 bg-zinc-800/50' : 'border-transparent hover:border-zinc-800 hover:bg-zinc-800/20'}`}>
                  <div
                    className="flex items-start gap-2 px-2 py-2 cursor-pointer"
                    onClick={() => handleExpand(item.link)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm leading-snug line-clamp-2 ${isExpanded ? 'text-zinc-200' : 'text-zinc-300'}`}>{item.title}</div>
                      <div className="text-xs text-zinc-600 mt-0.5">{item.source} · {formatDate(item.pubDate)}</div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1 rounded text-zinc-700 hover:text-zinc-400 transition-colors text-xs"
                        title="Open article"
                      >↗</a>
                      <span className={`text-zinc-700 text-[10px] transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-2 pb-2 border-t border-zinc-800/60 pt-2">
                      {item.summary ? (
                        <p className="text-xs text-zinc-500 leading-relaxed">{item.summary}</p>
                      ) : (
                        <p className="text-xs text-zinc-700 italic">No description available</p>
                      )}
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        Read article ↗
                      </a>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    const diff = (Date.now() - d.getTime()) / 1000 / 60
    if (diff < 60) return `${Math.round(diff)}m ago`
    if (diff < 1440) return `${Math.round(diff / 60)}h ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}
