'use client'

import { useEffect, useState } from 'react'
import type { HolidayTheme, ThemeName } from '@/lib/themes'
import { detectHolidayTheme, THEMES } from '@/lib/themes'

// Inject CSS custom property tokens into :root
function applyTokens(tokens: Record<string, string>) {
  const root = document.documentElement
  // Clear old tokens first
  for (const key of Object.keys(THEMES).flatMap(n =>
    Object.keys(THEMES[n as ThemeName].tokens)
  )) {
    root.style.removeProperty(key)
  }
  // Apply new ones
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value)
  }
}

// Snowflake component
function Snowflakes() {
  const flakes = Array.from({ length: 15 }, (_, i) => ({
    id: i,
    left: `${(i * 7 + 3) % 100}vw`,
    duration: `${5 + (i % 5)}s`,
    delay: `${(i * 0.4) % 4}s`,
    char: ['❄', '❅', '❆', '*'][i % 4],
    size: `${10 + (i % 6)}px`,
  }))

  return (
    <>
      <style>{`
        @keyframes snowfall {
          0%   { transform: translateY(-20px) rotate(0deg);   opacity: 0.7; }
          100% { transform: translateY(100vh)  rotate(360deg); opacity: 0;   }
        }
        .snowflake {
          position: fixed;
          top: -20px;
          color: #93c5fd;
          pointer-events: none;
          z-index: 0;
          animation: snowfall linear infinite;
        }
      `}</style>
      {flakes.map((f) => (
        <span
          key={f.id}
          className="snowflake"
          style={{ left: f.left, animationDuration: f.duration, animationDelay: f.delay, fontSize: f.size }}
        >
          {f.char}
        </span>
      ))}
    </>
  )
}

interface ThemeProviderProps {
  children: React.ReactNode
  /** Override auto-detect (e.g. from user settings) */
  forceTheme?: ThemeName
}

export default function ThemeProvider({ children, forceTheme }: ThemeProviderProps) {
  const [theme, setTheme] = useState<HolidayTheme | null>(null)

  useEffect(() => {
    const active = forceTheme && forceTheme !== 'default'
      ? THEMES[forceTheme]
      : detectHolidayTheme()

    setTheme(active)
    applyTokens(active?.tokens ?? {})

    // Set data-theme attribute for CSS selectors
    document.documentElement.setAttribute('data-theme', active?.name ?? 'default')

    return () => {
      applyTokens({})
      document.documentElement.setAttribute('data-theme', 'default')
    }
  }, [forceTheme])

  return (
    <>
      {/* Holiday banner */}
      {theme?.banner && (
        <div
          className="sticky top-0 z-50 text-center py-1.5 text-xs font-semibold tracking-wide"
          style={{
            background: 'var(--holiday-banner-bg, transparent)',
            color: 'var(--holiday-banner-text, inherit)',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {theme.banner}
        </div>
      )}

      {/* Snow effect for Christmas */}
      {theme?.snow && <Snowflakes />}

      {/* Holiday emoji particles in top-right corner */}
      {theme?.particles && (
        <div
          className="fixed top-3 right-4 z-40 pointer-events-none select-none"
          style={{ fontSize: '16px', letterSpacing: '6px', opacity: 0.5 }}
        >
          {theme.particles}
        </div>
      )}

      {children}
    </>
  )
}
