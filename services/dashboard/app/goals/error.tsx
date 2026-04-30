'use client'

import { useEffect } from 'react'

export default function GoalsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Goals page error:', error)
  }, [error])

  return (
    <div className="min-h-screen p-6 flex items-center justify-center">
      <div className="max-w-lg w-full bg-red-950/30 border border-red-900/50 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-red-400 uppercase tracking-wide mb-3">Goals Page Error</h2>
        <p className="text-xs text-red-300 font-mono break-all mb-2">{error.message}</p>
        {error.digest && (
          <p className="text-xs text-zinc-500 mb-4">Digest: {error.digest}</p>
        )}
        <pre className="text-[10px] text-zinc-500 overflow-auto max-h-40 bg-zinc-900/60 rounded p-2 mb-4">
          {error.stack}
        </pre>
        <button
          onClick={reset}
          className="text-xs px-3 py-1.5 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-800/40 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
