'use client'

import { useEffect, useState } from 'react'

export default function ScrollToTop() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 320)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!visible) return null

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-6 right-6 z-50 w-9 h-9 flex items-center justify-center rounded-full transition-all duration-200 opacity-70 hover:opacity-100 hover:scale-110"
      style={{
        background: 'rgba(30,22,45,0.85)',
        border: '1px solid rgba(167,139,250,0.35)',
        boxShadow: '0 0 14px rgba(109,40,217,0.25)',
        backdropFilter: 'blur(8px)',
      }}
      aria-label="Back to top"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 11V3M7 3L3 7M7 3L11 7" stroke="rgba(167,139,250,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}
