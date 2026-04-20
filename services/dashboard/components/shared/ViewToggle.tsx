'use client'

import { useRouter } from 'next/navigation'

interface ViewToggleProps {
  currentView: 'family' | 'lab' | 'haos'
}

const views = [
  { key: 'family', path: '/', icon: '🏠', label: 'Home' },
  { key: 'lab', path: '/lab', icon: '⚗️', label: 'Lab' },
  { key: 'haos', path: '/haos', icon: '🏡', label: 'HAOS' },
] as const

export default function ViewToggle({ currentView }: ViewToggleProps) {
  const router = useRouter()

  const otherViews = views.filter((v) => v.key !== currentView)

  return (
    <div className="flex items-center gap-1">
      {otherViews.map((view) => (
        <button
          key={view.key}
          onClick={() => router.push(view.path)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-300 hover:text-white transition-all"
          title={`Switch to ${view.label} view`}
        >
          <span>{view.icon}</span>
          <span>{view.label}</span>
        </button>
      ))}
    </div>
  )
}
