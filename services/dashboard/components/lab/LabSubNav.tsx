'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TOOLS = [
  { href: '/lab/terminal',  icon: '⌨️', label: 'Terminal',  color: '#22d3ee', glow: 'rgba(34,211,238,0.25)',  border: 'rgba(34,211,238,0.35)',  dim: 'rgba(34,211,238,0.08)'  },
  { href: '/lab/proxies',   icon: '🔀', label: 'Proxies',   color: '#a78bfa', glow: 'rgba(167,139,250,0.25)', border: 'rgba(167,139,250,0.35)', dim: 'rgba(167,139,250,0.08)' },
  { href: '/lab/rustdesk',  icon: '🖥️', label: 'RustDesk',  color: '#34d399', glow: 'rgba(52,211,153,0.25)',  border: 'rgba(52,211,153,0.35)',  dim: 'rgba(52,211,153,0.08)'  },
  { href: '/lab/traefik',   icon: '🔁', label: 'Traefik',   color: '#fb923c', glow: 'rgba(251,146,60,0.25)',  border: 'rgba(251,146,60,0.35)',  dim: 'rgba(251,146,60,0.08)'  },
]

export default function LabSubNav() {
  const pathname = usePathname()

  return (
    <div className="flex items-center gap-2 flex-wrap mb-6">
      {/* ← Lab — matches tool pill style */}
      <Link
        href="/lab"
        style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.4)', color: '#a78bfa' }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all duration-200 select-none no-underline opacity-90 hover:opacity-100 hover:scale-105"
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '0 0 14px rgba(167,139,250,0.35)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '' }}
      >
        <span>←</span>
        <span>Lab</span>
      </Link>

      {/* Divider */}
      <span className="text-zinc-700 text-xs">|</span>

      {/* Tool pills — all shown, active one is brighter */}
      {TOOLS.map((t) => {
        const isActive = pathname === t.href || pathname.startsWith(t.href + '/')
        return (
          <Link
            key={t.href}
            href={t.href}
            style={{
              background: isActive ? `rgba(${hexToRgb(t.color)}, 0.18)` : t.dim,
              border: `1px solid ${t.border}`,
              color: t.color,
              boxShadow: isActive ? `0 0 14px ${t.glow}` : undefined,
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all duration-200 select-none no-underline ${
              isActive ? 'opacity-100 scale-105' : 'opacity-60 hover:opacity-100 hover:scale-105'
            }`}
            onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.boxShadow = `0 0 12px ${t.glow}` }}
            onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.boxShadow = '' }}
          >
            <span style={{ fontSize: '13px' }}>{t.icon}</span>
            <span>{t.label}</span>
          </Link>
        )
      })}
    </div>
  )
}

function hexToRgb(hex: string): string {
  const m = hex.replace('#', '').match(/.{2}/g)
  if (!m) return '255,255,255'
  return m.map((x) => parseInt(x, 16)).join(',')
}
