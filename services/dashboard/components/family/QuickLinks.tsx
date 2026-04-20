import type { QuickLink } from '@/lib/config'

const ICON_EMOJIS: Record<string, string> = {
  photos: '📷',
  pdf: '📄',
  netflix: '🎬',
  disney: '🏰',
  youtube: '▶️',
  prime: '📦',
  amp: '🎮',
  adguard: '🛡️',
}

interface QuickLinksProps {
  links: QuickLink[]
}

export default function QuickLinks({ links }: QuickLinksProps) {
  return (
    <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col items-center gap-2 p-3 rounded-xl bg-zinc-800/50 hover:bg-zinc-700/50 border border-zinc-700/50 hover:border-zinc-600 transition-all group"
        >
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
            style={{ backgroundColor: link.color ? link.color + '33' : '#3f3f46' }}
          >
            {ICON_EMOJIS[link.icon ?? ''] ?? '🔗'}
          </div>
          <span className="text-xs text-zinc-400 group-hover:text-zinc-200 transition-colors text-center truncate w-full">
            {link.name}
          </span>
        </a>
      ))}
    </div>
  )
}
