'use client'

import Link from 'next/link'

const TOOLS = [
  { href: '/lab/terminal',  icon: '⌨️', label: 'Terminal',  color: '#22d3ee', glow: 'rgba(34,211,238,0.25)',  border: 'rgba(34,211,238,0.35)',  dim: 'rgba(34,211,238,0.08)', external: false },
  { href: '/lab/proxies',   icon: '🔀', label: 'Proxies',   color: '#a78bfa', glow: 'rgba(167,139,250,0.25)', border: 'rgba(167,139,250,0.35)', dim: 'rgba(167,139,250,0.08)', external: false },
  { href: '/lab/rustdesk',  icon: '🖥️', label: 'RustDesk',  color: '#34d399', glow: 'rgba(52,211,153,0.25)',  border: 'rgba(52,211,153,0.35)',  dim: 'rgba(52,211,153,0.08)', external: false },
  { href: '/lab/traefik', icon: '🔁', label: 'Traefik', color: '#fb923c', glow: 'rgba(251,146,60,0.25)', border: 'rgba(251,146,60,0.35)', dim: 'rgba(251,146,60,0.08)', external: false },
]

export default function ToolPills() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {TOOLS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          target={t.external ? '_blank' : undefined}
          rel={t.external ? 'noopener noreferrer' : undefined}
          style={{ background: t.dim, border: `1px solid ${t.border}`, color: t.color }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all duration-200 opacity-75 hover:opacity-100 hover:scale-105 select-none no-underline"
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = `0 0 12px ${t.glow}` }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '' }}
        >
          <span style={{ fontSize: '13px' }}>{t.icon}</span>
          <span>{t.label}</span>
        </Link>
      ))}
    </div>
  )
}
