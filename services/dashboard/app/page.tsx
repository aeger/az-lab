import { getConfig } from '@/lib/config'
import { readMessage } from '@/lib/message'
import ClockWidget from '@/components/family/ClockWidget'
import WeatherWidget from '@/components/family/WeatherWidget'
import PhotoSlideshow from '@/components/family/PhotoSlideshow'
import MessageBlock from '@/components/family/MessageBlock'
import CalendarWidget from '@/components/family/CalendarWidget'
import GmailWidget from '@/components/family/GmailWidget'
import AuthIndicator from '@/components/shared/AuthIndicator'

export const dynamic = 'force-dynamic'

const card = 'relative card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4'

export default function FamilyPage() {
  const config = getConfig()
  const message = readMessage()

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      {/* Page action bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Cook Family" className="w-10 h-10 rounded-full" />
          <ClockWidget />
        </div>
        <AuthIndicator />
      </div>

      {/* Message Block */}
      <div className="mb-4">
        <MessageBlock initialMessage={message} />
      </div>

      {/* Weather + Photos */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className={`${card} min-h-52`}>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Weather</h2>
          <WeatherWidget />
        </div>
        <div className="relative card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl overflow-hidden min-h-52">
          <PhotoSlideshow intervalSeconds={config.family.photo_interval_seconds} />
        </div>
      </div>

      {/* Calendar */}
      <div className={`${card} mb-4`}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Family Calendar</h2>
        <CalendarWidget />
      </div>

      {/* Gmail Inbox */}
      <div className={`${card} mb-4`}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Inbox</h2>
        <GmailWidget />
      </div>

    </div>
  )
}
