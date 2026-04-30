import LabSubNav from '@/components/lab/LabSubNav'
import TraefikRouters from '@/components/lab/TraefikRouters'

export const dynamic = 'force-dynamic'

const card = 'relative card-lift bg-zinc-900/50 border border-zinc-800/70 rounded-xl p-4'

export default function TraefikPage() {
  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <LabSubNav />
      <div className={card}>
        <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-4">Traefik Routers</h2>
        <TraefikRouters />
      </div>
    </div>
  )
}
