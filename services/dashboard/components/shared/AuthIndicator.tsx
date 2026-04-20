'use client'

import { useEffect, useRef, useState } from 'react'

interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  user?: string
}

const AUTH_LOGIN_URL  = 'https://auth.az-lab.dev/?rd=https://home.az-lab.dev'
const AUTH_LOGOUT_URL = 'https://auth.az-lab.dev/logout'

export default function AuthIndicator() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/auth')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          setAuth({ status: 'authenticated', user: data.user })
        } else {
          setAuth({ status: 'unauthenticated' })
        }
      })
      .catch(() => setAuth({ status: 'unauthenticated' }))
  }, [])

  // Close menu on outside click
  useEffect(() => {
    if (!menu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menu])

  if (auth.status === 'loading') return <div className="w-20 h-8" />

  if (auth.status === 'authenticated') {
    return (
      <div className="relative">
        <span
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 cursor-default select-none"
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          {auth.user}
        </span>

        {menu && (
          <div
            ref={menuRef}
            className="fixed z-[9999] min-w-[140px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl py-1 text-sm"
            style={{ top: menu.y, left: menu.x }}
          >
            <button
              className="w-full text-left px-3 py-2 text-red-400 hover:bg-zinc-800 hover:text-red-300 transition-colors flex items-center gap-2"
              onClick={() => { setMenu(null); window.location.href = AUTH_LOGOUT_URL }}
            >
              <span>⏻</span>
              <span>Sign out</span>
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <a
      href={AUTH_LOGIN_URL}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-400 hover:text-white transition-all"
    >
      <span className="w-2 h-2 rounded-full bg-zinc-600" />
      Sign in
    </a>
  )
}
