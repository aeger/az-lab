'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import Fuse from 'fuse.js'
import FeedEditor from '@/components/shared/FeedEditor'
import ArticleReaderPane from '@/components/shared/ArticleReaderPane'
import NewsDigest from '@/components/shared/NewsDigest'
import type { DigestSection } from '@/lib/news-intel'
import type { ArticleIntel } from '@/lib/news-intel'

interface NewsItem {
  title:    string
  link:     string
  pubDate:  string
  source:   string
  summary?: string
  imageUrl?: string
  feedType?: 'lab' | 'family'
  intel?:   ArticleIntel | null
}

const READ_LS_KEY    = 'az_news_read'
const MAX_READ_STORED = 500
const PAGE_SIZE       = 30

function getReadSet(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_LS_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch { return new Set() }
}

function persistRead(links: Set<string>) {
  try {
    const arr = [...links].slice(-MAX_READ_STORED)
    localStorage.setItem(READ_LS_KEY, JSON.stringify(arr))
  } catch {}
}

function formatAge(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const mins = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000)
    if (mins < 1)    return 'just now'
    if (mins < 60)   return `${mins}m ago`
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

/** Colored dot indicating article importance score */
function ImportanceDot({ score }: { score: number }) {
  const color =
    score >= 8 ? 'bg-red-500'    :
    score >= 6 ? 'bg-orange-400' :
    score >= 4 ? 'bg-yellow-500/70' :
                 'bg-zinc-700'
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px] ${color}`}
      title={`Importance ${score}/10`}
    />
  )
}

/** Keyboard help overlay */
function KeyboardHelpModal({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ['j / ↓',   'Next article'],
    ['k / ↑',   'Previous article'],
    ['Enter',   'Open in reader pane'],
    ['Space',   'Expand / collapse preview'],
    ['o',       'Open in new tab'],
    ['r',       'Mark as read'],
    ['/',       'Focus search'],
    ['Esc',     'Close reader / clear search'],
    ['?',       'Toggle this help'],
  ]
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-200 tracking-wide">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 transition-colors text-xs">✕</button>
        </div>
        <div className="space-y-2">
          {shortcuts.map(([key, desc]) => (
            <div key={key} className="flex items-center gap-3">
              <kbd className="min-w-[52px] text-center px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-mono">
                {key}
              </kbd>
              <span className="text-xs text-zinc-400">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-zinc-700 mt-5">Works in Feed and Cards views</p>
      </div>
    </div>
  )
}

type FilterType  = 'all' | 'lab' | 'family'
type ViewMode    = 'list' | 'digest' | 'cards' | 'clusters'
type EditorState = { open: boolean; type: 'lab' | 'family' }

export default function NewsReader() {
  const [items,          setItems]          = useState<NewsItem[]>([])
  const [cachedAt,       setCachedAt]       = useState<string | null>(null)
  const [loading,        setLoading]        = useState(true)
  const [filter,         setFilter]         = useState<FilterType>('all')
  const [topicFilter,    setTopicFilter]    = useState<string | null>(null)
  const [search,         setSearch]         = useState('')
  const [visibleCount,   setVisibleCount]   = useState(PAGE_SIZE)
  const [expanded,       setExpanded]       = useState<string | null>(null)
  const [savedItems,     setSavedItems]     = useState<Map<string, 'saving' | 'saved' | 'error'>>(new Map())
  const [readerUrl,      setReaderUrl]      = useState<string | null>(null)
  const [readerItem,     setReaderItem]     = useState<NewsItem | null>(null)
  const [readLinks,      setReadLinks]      = useState<Set<string>>(new Set())
  const [editor,         setEditor]         = useState<EditorState>({ open: false, type: 'lab' })
  const [reloadKey,      setReloadKey]      = useState(0)
  const [focusedIdx,     setFocusedIdx]     = useState<number>(-1)
  const [viewMode,       setViewMode]       = useState<ViewMode>('list')
  const [analyzing,      setAnalyzing]      = useState(false)
  const [digest,         setDigest]         = useState<DigestSection[]>([])
  const [analyzedAt,     setAnalyzedAt]     = useState<string | null>(null)
  const [topics,         setTopics]         = useState<string[]>([])
  const [showHelp,       setShowHelp]       = useState(false)
  const listRef   = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Load read state from localStorage on mount
  useEffect(() => { setReadLinks(getReadSet()) }, [])

  async function load() {
    setLoading(true)
    try {
      const res  = await fetch('/api/news?type=all')
      const data = await res.json()
      setItems(data.items ?? [])
      setCachedAt(data.cachedAt ?? null)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [reloadKey])

  // Reset visible count when filter or search changes
  useEffect(() => { setVisibleCount(PAGE_SIZE); setFocusedIdx(-1) }, [filter, topicFilter, search])

  async function analyze() {
    setAnalyzing(true)
    try {
      const res  = await fetch('/api/news/analyze')
      const data = await res.json()

      if (data.items) {
        setItems(data.items)
      }

      if (data.digest)     setDigest(data.digest)
      if (data.analyzedAt) setAnalyzedAt(data.analyzedAt)
      if (data.clusters) {
        setTopics((data.clusters as Array<{ topic: string }>).map((c) => c.topic))
      }
    } catch (err) {
      console.error('analyze failed', err)
    }
    setAnalyzing(false)
  }

  function getItemIntel(item: NewsItem): ArticleIntel | undefined {
    return item.intel ?? undefined
  }

  function markRead(link: string) {
    setReadLinks((prev) => {
      const next = new Set(prev)
      next.add(link)
      persistRead(next)
      return next
    })
  }

  function markUnread(link: string, e: React.MouseEvent) {
    e.stopPropagation()
    setReadLinks((prev) => {
      const next = new Set(prev)
      next.delete(link)
      persistRead(next)
      return next
    })
  }

  function openInReader(item: NewsItem) {
    setReaderUrl(item.link)
    setReaderItem(item)
    markRead(item.link)
  }

  function openInReaderByParts(url: string, title: string, source: string, pubDate: string) {
    const found = items.find((i) => i.link === url)
    if (found) { openInReader(found) } else {
      setReaderUrl(url)
      setReaderItem({ title, link: url, source, pubDate })
      markRead(url)
    }
  }

  function handleExpand(link: string) {
    if (expanded === link) { setExpanded(null) } else { setExpanded(link); markRead(link) }
  }

  function openArticle(e: React.MouseEvent, link: string) {
    e.stopPropagation()
    markRead(link)
    window.open(link, '_blank', 'noopener,noreferrer')
  }

  function clearAllRead() {
    setReadLinks(new Set())
    try { localStorage.removeItem(READ_LS_KEY) } catch {}
  }

  async function saveItem(item: NewsItem, e: React.MouseEvent) {
    e.stopPropagation()
    const key = item.link
    if (savedItems.get(key) === 'saving' || savedItems.get(key) === 'saved') return
    setSavedItems((prev) => new Map(prev).set(key, 'saving'))
    try {
      const res = await fetch('/api/save-article', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: item.link, title: item.title, excerpt: item.summary ?? '', source: item.source }),
      })
      setSavedItems((prev) => new Map(prev).set(key, res.ok ? 'saved' : 'error'))
    } catch {
      setSavedItems((prev) => new Map(prev).set(key, 'error'))
    }
  }

  // Filtering pipeline
  const byType = filter === 'all' ? items : items.filter((i) => i.feedType === filter)
  const byTopic = topicFilter
    ? byType.filter((i) => getItemIntel(i)?.topic === topicFilter)
    : byType
  const q = search.trim()

  const fuse = useMemo(
    () => new Fuse(byTopic, {
      keys:             [{ name: 'title', weight: 0.6 }, { name: 'source', weight: 0.25 }, { name: 'summary', weight: 0.15 }],
      threshold:        0.4,
      ignoreLocation:   true,
      minMatchCharLength: 2,
    }),
    [byTopic]
  )

  const filtered     = q ? fuse.search(q).map((r) => r.item) : byTopic
  const visible      = filtered.slice(0, visibleCount)
  const hasMore      = visibleCount < filtered.length
  const labCount     = items.filter((i) => i.feedType === 'lab').length
  const familyCount  = items.filter((i) => i.feedType === 'family').length
  const unreadCount  = filtered.filter((i) => !readLinks.has(i.link)).length
  const hasIntel     = items.some((i) => i.intel)
  const focusedKey   = focusedIdx >= 0 ? visible[focusedIdx]?.link : null

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

    // ? key: toggle keyboard help (any mode)
    if (e.key === '?') {
      e.preventDefault()
      setShowHelp((prev) => !prev)
      return
    }

    // Escape: close help → close reader → clear search
    if (e.key === 'Escape') {
      if (showHelp) { setShowHelp(false); return }
      if (readerUrl) { setReaderUrl(null); setReaderItem(null) }
      else if (search) setSearch('')
      return
    }

    if (viewMode !== 'list' && viewMode !== 'cards') return

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIdx((i) => Math.min(i + 1, visible.length - 1))
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && focusedIdx >= 0) {
      e.preventDefault()
      const item = visible[focusedIdx]
      if (item) openInReader(item)
    } else if (e.key === ' ' && focusedIdx >= 0 && viewMode === 'list') {
      e.preventDefault()
      const item = visible[focusedIdx]
      if (item) handleExpand(item.link)
    } else if (e.key === 'o' && focusedIdx >= 0) {
      const item = visible[focusedIdx]
      if (item) { markRead(item.link); window.open(item.link, '_blank', 'noopener,noreferrer') }
    } else if (e.key === 'r' && focusedIdx >= 0) {
      const item = visible[focusedIdx]
      if (item) markRead(item.link)
    } else if (e.key === '/' && !readerUrl) {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }, [visible, focusedIdx, expanded, readerUrl, search, viewMode, showHelp]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    if (focusedIdx >= 0 && listRef.current) {
      const el = listRef.current.children[focusedIdx] as HTMLElement | undefined
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [focusedIdx])

  /** Shared search + filter bar used by list and cards views */
  function SearchFilterBar() {
    return (
      <>
        {/* Search bar */}
        <div className="mb-4">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600 text-xs select-none pointer-events-none">
              /
            </span>
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search articles… (press / to focus)"
              className="w-full pl-7 pr-4 py-2 rounded-lg bg-zinc-800/60 border border-zinc-700/60 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors text-xs"
              >
                ✕
              </button>
            )}
          </div>
          {search && (
            <p className="text-[10px] text-zinc-600 mt-1 ml-1">
              {filtered.length} result{filtered.length !== 1 ? 's' : ''} for &ldquo;{search}&rdquo;
            </p>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 mb-3 flex-wrap">
          {(['all', 'lab', 'family'] as FilterType[]).map((f) => {
            const count      = f === 'all' ? items.length : f === 'lab' ? labCount : familyCount
            const active     = filter === f && !topicFilter
            const activeClass =
              f === 'lab'    ? 'bg-orange-500/15 text-orange-400 border-orange-500/30' :
              f === 'family' ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'   :
                               'bg-zinc-700/60 text-zinc-200 border-zinc-600'
            const inactiveClass = 'text-zinc-500 hover:text-zinc-300 border-transparent hover:border-zinc-700'
            return (
              <button
                key={f}
                onClick={() => { setFilter(f); setTopicFilter(null); setFocusedIdx(-1) }}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${active ? activeClass : inactiveClass}`}
              >
                {f === 'all' ? 'All' : f === 'lab' ? 'Tech' : 'Family'}
                <span className={`ml-1 ${active ? 'opacity-70' : 'opacity-40'}`}>({count})</span>
              </button>
            )
          })}
          {unreadCount > 0 && !topicFilter && (
            <button
              onClick={clearAllRead}
              className="ml-auto text-xs text-zinc-700 hover:text-zinc-500 transition-colors"
              title="Reset read state"
            >
              mark all unread
            </button>
          )}
          <button
            onClick={() => setShowHelp(true)}
            className="text-[10px] text-zinc-700 hover:text-zinc-500 transition-colors ml-1"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
        </div>

        {/* Topic cluster filter */}
        {hasIntel && topics.length > 0 && (
          <div className="flex items-center gap-1 mb-4 flex-wrap">
            <button
              onClick={() => setTopicFilter(null)}
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium border transition-colors ${
                !topicFilter
                  ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
                  : 'text-zinc-600 border-transparent hover:border-zinc-700 hover:text-zinc-400'
              }`}
            >
              All topics
            </button>
            {topics.map((topic) => (
              <button
                key={topic}
                onClick={() => setTopicFilter(topicFilter === topic ? null : topic)}
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium border transition-colors ${
                  topicFilter === topic
                    ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
                    : 'text-zinc-600 border-transparent hover:border-zinc-700 hover:text-zinc-400'
                }`}
              >
                {topic}
              </button>
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {showHelp && <KeyboardHelpModal onClose={() => setShowHelp(false)} />}

      {editor.open && (
        <FeedEditor
          type={editor.type}
          onClose={() => setEditor((s) => ({ ...s, open: false }))}
          onSaved={() => { setEditor((s) => ({ ...s, open: false })); setReloadKey((k) => k + 1) }}
        />
      )}

      <ArticleReaderPane
        url={readerUrl}
        title={readerItem?.title}
        source={readerItem?.source}
        pubDate={readerItem?.pubDate}
        intel={readerItem?.intel ?? undefined}
        onClose={() => { setReaderUrl(null); setReaderItem(null) }}
      />

      <div className="min-h-screen p-4 md:p-6 max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="text-lg">📰</span>
            <h1 className="text-sm font-semibold text-zinc-300 tracking-wide uppercase">News Feed</h1>
            {!loading && unreadCount > 0 && viewMode === 'list' && (
              <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-medium">
                {unreadCount} unread
              </span>
            )}
            {cachedAt && !loading && (
              <span className="text-[10px] text-zinc-600">· cached {formatAge(cachedAt)}</span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* AI Analyze button */}
            <button
              onClick={analyze}
              disabled={analyzing}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                analyzing
                  ? 'border-purple-700/40 text-purple-500/60 cursor-wait'
                  : hasIntel
                  ? 'border-purple-700/40 text-purple-400 hover:border-purple-500/60 hover:text-purple-300'
                  : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
              }`}
              title="Analyze with Nemotron — adds TL;DR, importance scores, topic clusters"
            >
              {analyzing ? (
                <>
                  <span className="w-3 h-3 border border-purple-500 border-t-transparent rounded-full animate-spin" />
                  Analyzing…
                </>
              ) : hasIntel ? (
                '✦ Re-analyze'
              ) : (
                '✦ AI Analyze'
              )}
            </button>
            <button
              onClick={() => setEditor({ open: true, type: 'lab' })}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ⚙ Tech feeds
            </button>
            <button
              onClick={() => setEditor({ open: true, type: 'family' })}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ⚙ Family feeds
            </button>
            <button
              onClick={load}
              disabled={loading}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
            >
              {loading ? 'loading…' : 'refresh'}
            </button>
          </div>
        </div>

        {/* View mode tabs */}
        <div className="flex items-center gap-1 mb-4 flex-wrap">
          {(
            [
              { id: 'list',     label: 'Feed' },
              { id: 'cards',    label: '⊞ Cards' },
              { id: 'digest',   label: '✦ Digest' },
              { id: 'clusters', label: '◉ Clusters' },
            ] as { id: ViewMode; label: string }[]
          ).map(({ id, label }) => {
            const isActive = viewMode === id
            const activeClass =
              id === 'digest' || id === 'clusters'
                ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
                : 'bg-zinc-700/60 text-zinc-200 border-zinc-600'
            return (
              <button
                key={id}
                onClick={() => setViewMode(id)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  isActive ? activeClass : 'text-zinc-500 hover:text-zinc-300 border-transparent hover:border-zinc-700'
                }`}
              >
                {label}
                {id === 'digest' && digest.length > 0 && (
                  <span className="ml-1 opacity-70">({digest.length})</span>
                )}
                {id === 'clusters' && topics.length > 0 && (
                  <span className="ml-1 opacity-70">({topics.length})</span>
                )}
              </button>
            )
          })}
        </div>

        {/* ── DIGEST VIEW ──────────────────────────────────────────────────── */}
        {viewMode === 'digest' && (
          <NewsDigest
            digest={digest}
            analyzedAt={analyzedAt}
            onOpenReader={openInReaderByParts}
          />
        )}

        {/* ── CLUSTERS VIEW ────────────────────────────────────────────────── */}
        {viewMode === 'clusters' && (
          <>
            {hasIntel && topics.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {topics.map((topic) => {
                  const topicItems = byType
                    .filter((i) => i.intel?.topic === topic)
                    .sort((a, b) => (b.intel?.score ?? 0) - (a.intel?.score ?? 0))
                  const avgScore = topicItems.length > 0
                    ? topicItems.reduce((s, i) => s + (i.intel?.score ?? 0), 0) / topicItems.length
                    : 0
                  const topItem = topicItems[0]
                  const scorePct = Math.round(avgScore * 10)
                  const barColor =
                    avgScore >= 8 ? 'bg-red-500/60'    :
                    avgScore >= 6 ? 'bg-orange-400/60' :
                    avgScore >= 4 ? 'bg-yellow-500/50' :
                                   'bg-purple-500/40'
                  return (
                    <div
                      key={topic}
                      className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden hover:border-purple-500/30 cursor-pointer transition-all group"
                      onClick={() => { setTopicFilter(topic); setViewMode('list') }}
                    >
                      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide group-hover:text-purple-300 transition-colors">
                          {topic}
                        </span>
                        <span className="text-[10px] text-zinc-600">{topicItems.length} art.</span>
                      </div>
                      <div className="p-3 space-y-2.5">
                        {/* Avg importance bar */}
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                            <div className={`h-1 rounded-full transition-all ${barColor}`} style={{ width: `${scorePct}%` }} />
                          </div>
                          <span className="text-[10px] text-zinc-600">{avgScore.toFixed(1)}/10</span>
                        </div>
                        {/* Top article preview */}
                        {topItem && (
                          <>
                            <p className="text-xs text-zinc-400 leading-snug line-clamp-2">{topItem.title}</p>
                            {topItem.intel?.tldr && (
                              <p className="text-[11px] text-purple-400/60 italic leading-relaxed line-clamp-2">
                                {topItem.intel.tldr}
                              </p>
                            )}
                          </>
                        )}
                        {/* Mini article list */}
                        <div className="space-y-1 pt-1">
                          {topicItems.slice(0, 3).map((item) => (
                            <div key={item.link} className="flex items-start gap-1.5">
                              <ImportanceDot score={item.intel?.score ?? 0} />
                              <span
                                className="text-[11px] text-zinc-500 leading-tight line-clamp-1 hover:text-zinc-300 transition-colors"
                                onClick={(e) => { e.stopPropagation(); openInReader(item) }}
                              >
                                {item.title}
                              </span>
                            </div>
                          ))}
                          {topicItems.length > 3 && (
                            <span className="text-[10px] text-zinc-700">+{topicItems.length - 3} more</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-zinc-500 text-sm text-center py-16">
                Run ✦ AI Analyze first to see topic clusters.
              </div>
            )}
          </>
        )}

        {/* ── CARDS VIEW ───────────────────────────────────────────────────── */}
        {viewMode === 'cards' && (
          <>
            <SearchFilterBar />
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <div className="w-6 h-6 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-zinc-500 text-sm text-center py-16">
                {search ? `No results for "${search}"` : 'No items — use ⚙ to add feeds'}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {visible.map((item, idx) => {
                    const intel   = getItemIntel(item)
                    const isRead  = readLinks.has(item.link)
                    const isFocused = focusedKey === item.link
                    const accent  = item.feedType === 'lab' ? '#fb923c' : '#f59e0b'
                    return (
                      <div
                        key={item.link || idx}
                        className={`rounded-xl border overflow-hidden cursor-pointer transition-all card-lift ${
                          isFocused
                            ? 'border-zinc-600 bg-zinc-800/60'
                            : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                        }`}
                        onClick={() => { setFocusedIdx(idx); openInReader(item) }}
                      >
                        {/* Thumbnail */}
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="w-full h-36 object-cover opacity-80"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <div className="w-full h-20 bg-zinc-800/60 flex items-center justify-center">
                            <span className="text-2xl opacity-20">📰</span>
                          </div>
                        )}

                        {/* Card body */}
                        <div className="p-3 space-y-1.5">
                          <div className="flex items-start gap-1.5">
                            {intel && <ImportanceDot score={intel.score} />}
                            <h3 className={`text-sm leading-snug font-medium ${isRead ? 'text-zinc-500' : 'text-zinc-200'}`}>
                              {item.title}
                            </h3>
                          </div>

                          {intel?.tldr && (
                            <p className="text-[11px] text-zinc-500 leading-relaxed italic line-clamp-2">
                              {intel.tldr}
                            </p>
                          )}

                          <div className="flex items-center gap-2 pt-0.5 flex-wrap">
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                              style={{ background: `${accent}18`, color: accent }}
                            >
                              {item.source}
                            </span>
                            {intel && (
                              <span className="text-[10px] text-purple-500/60 font-medium">{intel.topic}</span>
                            )}
                            <span className="text-[10px] text-zinc-600 ml-auto">{formatAge(item.pubDate)}</span>
                          </div>
                        </div>

                        {/* Footer actions */}
                        <div className="px-3 pb-3 flex items-center gap-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); openInReader(item) }}
                            className="flex-1 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-colors text-center"
                          >
                            Read
                          </button>
                          <button
                            onClick={(e) => openArticle(e, item.link)}
                            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
                            title="Open original"
                          >
                            ↗
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {hasMore && (
                  <div className="flex items-center justify-center mt-6 pt-4 border-t border-zinc-800">
                    <button
                      onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                      className="px-4 py-1.5 rounded-lg text-xs text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      Load more <span className="text-zinc-600 ml-1">({filtered.length - visibleCount} remaining)</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ── LIST VIEW ────────────────────────────────────────────────────── */}
        {viewMode === 'list' && (
          <>
            <SearchFilterBar />

            {/* Article list */}
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <div className="w-6 h-6 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-zinc-500 text-sm text-center py-16">
                {search ? `No results for "${search}"` : 'No items — use ⚙ to add feeds'}
              </div>
            ) : (
              <>
                <div className="space-y-1" ref={listRef}>
                  {visible.map((item, idx) => {
                    const isRead     = readLinks.has(item.link)
                    const isExpanded = expanded === item.link
                    const isFocused  = focusedKey === item.link
                    const accent     = item.feedType === 'lab' ? '#fb923c' : '#f59e0b'
                    const intel      = getItemIntel(item)

                    return (
                      <div
                        key={item.link || idx}
                        className={`rounded-lg border transition-all cursor-pointer select-none ${
                          isExpanded
                            ? 'border-zinc-600 bg-zinc-800/60'
                            : isFocused
                            ? 'border-zinc-600 bg-zinc-800/40'
                            : 'border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-800/30'
                        }`}
                        onClick={() => { setFocusedIdx(idx); handleExpand(item.link) }}
                        onDoubleClick={(e) => { e.stopPropagation(); openInReader(item) }}
                      >
                        {/* Article row */}
                        <div className="flex items-start gap-3 px-4 py-3">
                          {item.imageUrl && !isExpanded && (
                            <img
                              src={item.imageUrl}
                              alt=""
                              className="w-14 h-14 rounded-md object-cover flex-shrink-0 opacity-80"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start gap-2">
                              {intel && <ImportanceDot score={intel.score} />}
                              <div className={`text-sm leading-snug transition-colors ${isRead && !isExpanded ? 'text-zinc-500' : 'text-zinc-200'}`}>
                                {item.title}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              <span
                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                style={{ background: `${accent}18`, color: accent }}
                              >
                                {item.source}
                              </span>
                              {intel && (
                                <span className="text-[10px] text-purple-500/60 font-medium">
                                  {intel.topic}
                                </span>
                              )}
                              <span className="text-[10px] text-zinc-600">{formatAge(item.pubDate)}</span>
                              {isRead && !isExpanded && (
                                <button
                                  className="text-[10px] text-zinc-700 hover:text-zinc-500 transition-colors"
                                  onClick={(e) => markUnread(item.link, e)}
                                  title="Mark unread"
                                >
                                  · mark unread
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0 self-center ml-1">
                            <button
                              onClick={(e) => { e.stopPropagation(); openInReader(item) }}
                              className="p-1.5 rounded text-zinc-600 hover:text-blue-400 hover:bg-zinc-700 transition-colors text-[11px] font-medium"
                              title="Read in pane (Enter)"
                            >
                              Read
                            </button>
                            <button
                              onClick={(e) => openArticle(e, item.link)}
                              className="p-1.5 rounded text-zinc-600 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                              title="Open article in new tab"
                            >
                              ↗
                            </button>
                            <span className={`text-zinc-600 text-[10px] transition-transform duration-200 inline-block ${isExpanded ? 'rotate-180' : ''}`}>
                              ▾
                            </span>
                          </div>
                        </div>

                        {/* Expanded preview */}
                        {isExpanded && (
                          <div className="px-4 pb-4 border-t border-zinc-700/50 pt-3">
                            {item.imageUrl && (
                              <img
                                src={item.imageUrl}
                                alt=""
                                className="w-full max-h-52 object-cover rounded-lg mb-3 opacity-90"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            )}

                            {/* AI TL;DR */}
                            {intel?.tldr && (
                              <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-lg bg-purple-500/8 border border-purple-500/20">
                                <span className="text-[10px] font-semibold text-purple-400 flex-shrink-0 mt-0.5">AI</span>
                                <p className="text-sm text-zinc-300 leading-relaxed italic">{intel.tldr}</p>
                                <span className="text-[10px] text-zinc-600 flex-shrink-0 mt-0.5">{intel.score}/10</span>
                              </div>
                            )}

                            {/* Original summary */}
                            {item.summary ? (
                              <p className="text-sm text-zinc-400 leading-relaxed">
                                {item.summary}
                              </p>
                            ) : (
                              <p className="text-xs text-zinc-600 italic">No description in feed — click to read the full article.</p>
                            )}

                            <div className="flex items-center gap-3 mt-4 flex-wrap">
                              <button
                                onClick={(e) => { e.stopPropagation(); openInReader(item) }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white text-xs font-medium transition-colors"
                              >
                                Read in pane
                              </button>
                              <button
                                onClick={(e) => openArticle(e, item.link)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 hover:text-white text-xs font-medium transition-colors"
                              >
                                Open original ↗
                              </button>
                              <button
                                onClick={(e) => saveItem(item, e)}
                                disabled={savedItems.get(item.link) === 'saving' || savedItems.get(item.link) === 'saved'}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                  savedItems.get(item.link) === 'saved'
                                    ? 'bg-emerald-600/20 text-emerald-400 cursor-default'
                                    : savedItems.get(item.link) === 'error'
                                    ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                                    : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white'
                                }`}
                              >
                                {savedItems.get(item.link) === 'saving' ? 'Saving…' : savedItems.get(item.link) === 'saved' ? 'Saved ✓' : savedItems.get(item.link) === 'error' ? 'Failed' : 'Save'}
                              </button>
                              <button
                                onClick={(e) => markUnread(item.link, e)}
                                className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                              >
                                mark unread
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setExpanded(null) }}
                                className="text-xs text-zinc-700 hover:text-zinc-500 transition-colors ml-auto"
                              >
                                collapse
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Load more */}
                {hasMore && (
                  <div className="flex items-center justify-center mt-6 pt-4 border-t border-zinc-800">
                    <button
                      onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                      className="px-4 py-1.5 rounded-lg text-xs text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      Load more <span className="text-zinc-600 ml-1">({filtered.length - visibleCount} remaining)</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
