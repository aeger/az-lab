'use client'

import { useState, useEffect, useCallback } from 'react'
import HADashboardEditor from './HADashboardEditor'

interface Dashboard {
  title: string
  path: string
}

interface HADashboardProps {
  haUrl: string
  defaultDashboard: string
}

const LS_KEY = 'ha_active_dashboard'

export default function HADashboard({ haUrl, defaultDashboard }: HADashboardProps) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [activePath, setActivePath] = useState(defaultDashboard)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LS_KEY)
      if (stored) setActivePath(stored)
    } catch {}
  }, [])
  const [showEditor, setShowEditor] = useState(false)

  function selectDashboard(path: string) {
    setActivePath(path)
    try { localStorage.setItem(LS_KEY, path) } catch {}
  }

  const loadDashboards = useCallback(() => {
    fetch('/api/homeassistant/dashboards')
      .then((r) => r.json())
      .then((data) => {
        if (data.dashboards?.length) {
          // Overview first, rest alphabetical
          const sorted = [...data.dashboards].sort((a: Dashboard, b: Dashboard) => {
            if (a.title.toLowerCase() === 'overview') return -1
            if (b.title.toLowerCase() === 'overview') return 1
            return a.title.localeCompare(b.title)
          })
          setDashboards(sorted)
        }
      })
      .catch(() => {
        setDashboards([{ title: 'Dashboard', path: defaultDashboard }])
      })
  }, [defaultDashboard])

  useEffect(() => { loadDashboards() }, [loadDashboards])

  const iframeSrc = `${haUrl}${activePath.startsWith('/') ? activePath : '/' + activePath}?kiosk`

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Dashboard selector bar */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-zinc-900 border-b border-zinc-800">
        <span className="text-xs text-zinc-500">Dashboard:</span>
        <div className="flex gap-1 flex-1">
          {dashboards.map((d, i) => {
            const path = d.path.startsWith('/') ? d.path : '/' + d.path
            const isActive = activePath === path || activePath === d.path
            return (
              <button
                key={i}
                onClick={() => selectDashboard(path)}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'
                }`}
              >
                {d.title}
              </button>
            )
          })}
        </div>
        <button
          onClick={() => setShowEditor(true)}
          className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
          title="Manage dashboards"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* Iframe */}
      <iframe
        src={iframeSrc}
        className="flex-1 w-full border-0"
        allow="fullscreen"
        title="Home Assistant"
      />

      {/* Editor modal */}
      {showEditor && (
        <HADashboardEditor
          onClose={() => setShowEditor(false)}
          onSaved={loadDashboards}
        />
      )}
    </div>
  )
}
