import LabSubNav from '@/components/lab/LabSubNav'
import ProxiesWidget from '@/components/lab/ProxiesWidget'

export const dynamic = 'force-dynamic'

const card = 'relative card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4'

export default function ProxiesPage() {
  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <LabSubNav />
      <div className={card}>
        <ProxiesWidget />
      </div>
    </div>
  )
}
