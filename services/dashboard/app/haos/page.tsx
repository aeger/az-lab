import { getConfig } from '@/lib/config'
import HADashboard from '@/components/haos/HADashboard'

export const dynamic = 'force-dynamic'

export default function HAOSPage() {
  const config = getConfig()
  const haUrl = config.homeassistant?.url ?? 'https://ha.az-lab.dev'
  const defaultDashboard = config.homeassistant?.default_dashboard ?? '/home/overview'

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 268px)' }}>
      <HADashboard haUrl={haUrl} defaultDashboard={defaultDashboard} />
    </div>
  )
}
