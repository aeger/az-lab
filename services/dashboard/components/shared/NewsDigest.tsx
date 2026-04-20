'use client'

import type { DigestSection } from '@/lib/news-intel'

interface Props {
  digest:      DigestSection[]
  analyzedAt:  string | null
  onOpenReader: (url: string, title: string, source: string, pubDate: string) => void
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

function scoreDot(score: number) {
  const color =
    score >= 8 ? 'bg-red-500'    :
    score >= 6 ? 'bg-orange-400' :
    score >= 4 ? 'bg-yellow-500' :
                 'bg-zinc-600'
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${color}`} title={`Importance ${score}/10`} />
}

export default function NewsDigest({ digest, analyzedAt, onOpenReader }: Props) {
  if (digest.length === 0) {
    return (
      <div className="text-zinc-500 text-sm text-center py-16">
        No digest available yet — click &ldquo;Analyze&rdquo; to generate.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {analyzedAt && (
        <p className="text-[10px] text-zinc-600 text-right">
          digest generated {formatAge(analyzedAt)} via Nemotron
        </p>
      )}

      {digest.map((section) => (
        <div key={section.topic} className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          {/* Section header */}
          <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-300 tracking-wide uppercase">
              {section.topic}
            </span>
            <span className="text-[10px] text-zinc-600">
              {section.topItems.length} article{section.topItems.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Articles */}
          <div className="divide-y divide-zinc-800/60">
            {section.topItems.map((item) => (
              <div key={item.link} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors group">
                <div className="flex items-start gap-2.5">
                  {scoreDot(item.score)}
                  <div className="flex-1 min-w-0">
                    <button
                      onClick={() => onOpenReader(item.link, item.title, item.source, item.pubDate)}
                      className="text-sm text-zinc-200 hover:text-white text-left leading-snug transition-colors"
                    >
                      {item.title}
                    </button>
                    {item.tldr && (
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed italic">
                        {item.tldr}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] font-semibold text-orange-400/80">{item.source}</span>
                      <span className="text-[10px] text-zinc-600">{formatAge(item.pubDate)}</span>
                      <span className="text-[10px] text-zinc-700">score {item.score}/10</span>
                    </div>
                  </div>
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-zinc-300 text-xs p-1"
                    title="Open in new tab"
                  >
                    ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
