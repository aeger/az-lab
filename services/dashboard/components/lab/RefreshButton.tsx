'use client'

export default function RefreshButton() {
  return (
    <button
      onClick={() => window.location.reload()}
      className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-400 hover:text-white transition-all"
      title="Refresh page"
      aria-label="Refresh"
    >
      ↻
    </button>
  )
}
