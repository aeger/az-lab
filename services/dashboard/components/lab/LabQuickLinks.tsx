import type { QuickLink } from '@/lib/config'

const ICON_EMOJIS: Record<string, string> = {
  proxmox: '🖥️',
  portainer: '🐋',
  grafana: '📊',
  traefik: '🔀',
  adguard: '🛡️',
  'uptime-kuma': '💓',
  immich: '📷',
  calibre: '📚',
  audiobookshelf: '🎧',
  changedetect: '👁️',
  shelfmark: '🔖',
}

interface LabQuickLinksProps {
  links: QuickLink[]
}

export default function LabQuickLinks({ links }: LabQuickLinksProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-700/50 border border-zinc-700/50 hover:border-zinc-600 transition-all text-sm text-zinc-300 hover:text-white"
        >
          <span>{ICON_EMOJIS[link.icon ?? ''] ?? '🔗'}</span>
          {link.name}
        </a>
      ))}
    </div>
  )
}
