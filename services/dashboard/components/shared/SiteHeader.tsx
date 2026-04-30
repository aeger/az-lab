'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import QuickLinksDropdown from '@/components/shared/QuickLinksDropdown'
import NotificationBell from '@/components/shared/NotificationBell'

// Per-page color identities
const NAV_ITEMS = [
  {
    key: 'family',
    path: '/',
    label: 'Home',
    icon: '🏠',
    activeBg: 'linear-gradient(135deg, #f59e0b, #ef4444)',
    activeGlow: 'rgba(245,158,11,0.35)',
    activeBorder: 'rgba(245,158,11,0.5)',
    dimBg: 'rgba(245,158,11,0.08)',
    dimBorder: 'rgba(245,158,11,0.2)',
    dimColor: '#d97706',
  },
  {
    key: 'lab',
    path: '/lab',
    label: 'Lab Status',
    icon: '⚗️',
    activeBg: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
    activeGlow: 'rgba(6,182,212,0.35)',
    activeBorder: 'rgba(6,182,212,0.5)',
    dimBg: 'rgba(6,182,212,0.08)',
    dimBorder: 'rgba(6,182,212,0.2)',
    dimColor: '#0891b2',
  },
  {
    key: 'news',
    path: '/news',
    label: 'News Feed',
    icon: '📰',
    activeBg: 'linear-gradient(135deg, #fb923c, #f59e0b)',
    activeGlow: 'rgba(251,146,60,0.35)',
    activeBorder: 'rgba(251,146,60,0.5)',
    dimBg: 'rgba(251,146,60,0.08)',
    dimBorder: 'rgba(251,146,60,0.2)',
    dimColor: '#ea580c',
  },
  {
    key: 'haos',
    path: '/haos',
    label: 'Home Assistant',
    icon: '🏡',
    activeBg: 'linear-gradient(135deg, #10b981, #06d6a0)',
    activeGlow: 'rgba(16,185,129,0.35)',
    activeBorder: 'rgba(16,185,129,0.5)',
    dimBg: 'rgba(16,185,129,0.08)',
    dimBorder: 'rgba(16,185,129,0.2)',
    dimColor: '#059669',
  },
  {
    key: 'goals',
    path: '/goals',
    label: 'Vision & Goals',
    icon: '🎯',
    activeBg: 'linear-gradient(135deg, #8b5cf6, #c084fc)',
    activeGlow: 'rgba(139,92,246,0.35)',
    activeBorder: 'rgba(139,92,246,0.5)',
    dimBg: 'rgba(139,92,246,0.08)',
    dimBorder: 'rgba(139,92,246,0.2)',
    dimColor: '#7c3aed',
  },
] as const

type NavKey = typeof NAV_ITEMS[number]['key']

function currentKey(pathname: string): NavKey {
  if (pathname === '/') return 'family'
  if (pathname.startsWith('/lab')) return 'lab'
  if (pathname.startsWith('/haos')) return 'haos'
  if (pathname.startsWith('/goals')) return 'goals'
  if (pathname.startsWith('/news')) return 'news'
  return 'lab'
}

export default function SiteHeader() {
  const pathname = usePathname()
  const active = currentKey(pathname)

  return (
    <header className="relative w-full" style={{ zIndex: 100, position: 'relative' }}>
      {/* Banner image */}
      <div className="relative w-full overflow-hidden" style={{ height: '220px' }}>
        <img
          src="/header-banner.png"
          alt="AZ-Lab"
          className="w-full h-full object-cover object-center"
        />
        {/* Gradient overlay — darken bottom edge so nav sits on it cleanly */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(9,9,11,0.85) 100%)',
          }}
        />
        {/* Site title overlaid on banner */}
        <div className="absolute bottom-3 left-4 flex items-end gap-3">
          <span className="text-xs text-white/40 font-medium tracking-wide">svc-podman-01 · 192.168.1.181</span>
        </div>
      </div>

      {/* Nav tab bar — sits just below banner */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b relative"
        style={{
          background: 'rgba(9,9,11,0.95)',
          backdropFilter: 'blur(12px)',
          borderColor: 'rgba(255,255,255,0.06)',
          overflow: 'visible',
        }}
      >
        <div className="flex items-center gap-2 flex-1">
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active
          return (
            <Link
              key={item.key}
              href={item.path}
              style={
                isActive
                  ? {
                      background: item.activeBg,
                      border: `1px solid ${item.activeBorder}`,
                      boxShadow: `0 0 14px ${item.activeGlow}, inset 0 1px 0 rgba(255,255,255,0.15)`,
                      color: '#fff',
                    }
                  : {
                      background: item.dimBg,
                      border: `1px solid ${item.dimBorder}`,
                      color: item.dimColor,
                    }
              }
              className={[
                'flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide',
                'transition-all duration-200 no-underline select-none',
                isActive ? 'scale-105' : 'opacity-70 hover:opacity-100 hover:scale-105',
              ].join(' ')}
            >
              <span style={{ fontSize: '13px' }}>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          )
        })}
        </div>
        <NotificationBell />
        <QuickLinksDropdown />
      </div>
    </header>
  )
}
