'use client'

import dynamic from 'next/dynamic'

// No nav, no card, no padding — raw terminal fills the window
const TerminalHub = dynamic(() => import('@/components/lab/TerminalHub'), { ssr: false })

export default function TerminalPopout() {
  return (
    <div className="min-h-screen bg-[#09090b] flex flex-col" style={{ height: '100vh' }}>
      <TerminalHub popout />
    </div>
  )
}
