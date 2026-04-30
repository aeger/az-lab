'use client'

import { useEffect, useState, useRef, useCallback } from 'react'

interface Point { t: number; v: number }
interface HistoryData {
  cpu: Point[]
  ram: Point[]
  cpuModes: { user: Point[]; system: Point[]; iowait: Point[]; steal: Point[] }
  memBreakdown: { total: Point[]; free: Point[]; buffers: Point[]; cached: Point[]; available: Point[] }
}

const W = 500
const H = 88
const PAD = { top: 8, bottom: 22, left: 30, right: 8 }
const innerW = W - PAD.left - PAD.right
const innerH = H - PAD.top - PAD.bottom

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function fmtBytes(b: number) {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GiB`
  return `${(b / 1048576).toFixed(0)} MiB`
}

// ── Single-series sparkline ────────────────────────────────────────────────────

function Sparkline({ data, color, fillColor, label, unit = '%', maxY = 100 }: {
  data: Point[]; color: string; fillColor: string; label: string; unit?: string; maxY?: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; point: Point } | null>(null)

  if (data.length < 2) return <NoData label={label} />

  const minT = data[0].t, maxT = data[data.length - 1].t, tRange = maxT - minT || 1
  const xS = (t: number) => PAD.left + ((t - minT) / tRange) * innerW
  const yS = (v: number) => PAD.top + innerH - (Math.min(v, maxY) / maxY) * innerH

  const pts = data.map((p) => `${xS(p.t)},${yS(p.v)}`).join(' ')
  const last = data[data.length - 1]
  const areaPath = `M ${xS(data[0].t)} ${PAD.top + innerH} ` + data.map((p) => `L ${xS(p.t)} ${yS(p.v)}`).join(' ') + ` L ${xS(last.t)} ${PAD.top + innerH} Z`
  const tickIdxs = [0, 1, 2, 3, 4].map((i) => Math.round((i / 4) * (data.length - 1)))
  const avg = (data.reduce((s, p) => s + p.v, 0) / data.length).toFixed(1)
  const peak = Math.max(...data.map((p) => p.v)).toFixed(1)

  const onMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const svgX = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(((svgX - PAD.left) / innerW) * (data.length - 1))))
    const pt = data[idx]
    setTooltip({ x: xS(pt.t), y: yS(pt.v), point: pt })
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">{label} — 12h</span>
        <div className="flex items-center gap-3 text-[10px] tabular-nums">
          <span className="text-zinc-600">avg <span className="text-zinc-400">{avg}{unit}</span></span>
          <span className="text-zinc-600">peak <span className="text-zinc-400">{peak}{unit}</span></span>
          <span className="font-semibold" style={{ color }}>{last.v.toFixed(1)}{unit}</span>
        </div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: `${H}px` }} onMouseMove={onMove} onMouseLeave={() => setTooltip(null)}>
        <defs>
          <linearGradient id={`fill-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fillColor} stopOpacity="0.45" />
            <stop offset="100%" stopColor={fillColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[25, 50, 75].map((v) => (
          <g key={v}>
            <line x1={PAD.left} y1={yS(v)} x2={W - PAD.right} y2={yS(v)} stroke="#27272a" strokeWidth="1" />
            <text x={PAD.left - 3} y={yS(v) + 3.5} textAnchor="end" fontSize="8" fill="#52525b">{v}</text>
          </g>
        ))}
        <path d={areaPath} fill={`url(#fill-${label})`} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx={xS(last.t)} cy={yS(last.v)} r="3" fill={color} />
        {tickIdxs.map((i) => <text key={i} x={xS(data[i].t)} y={H - 2} textAnchor="middle" fontSize="8" fill="#52525b">{fmtTime(data[i].t)}</text>)}
        {tooltip && (
          <g>
            <line x1={tooltip.x} y1={PAD.top} x2={tooltip.x} y2={PAD.top + innerH} stroke="#52525b" strokeWidth="1" strokeDasharray="3 2" />
            <circle cx={tooltip.x} cy={tooltip.y} r="3.5" fill={color} stroke="#09090b" strokeWidth="1.5" />
            <rect x={Math.min(tooltip.x + 6, W - 72)} y={Math.max(tooltip.y - 18, PAD.top)} width="66" height="16" rx="4" fill="#18181b" stroke="#3f3f46" strokeWidth="1" />
            <text x={Math.min(tooltip.x + 39, W - 36)} y={Math.max(tooltip.y - 7, PAD.top + 9)} textAnchor="middle" fontSize="9" fill="white">
              {fmtTime(tooltip.point.t)} · {tooltip.point.v.toFixed(1)}{unit}
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}

// ── Stacked area chart ─────────────────────────────────────────────────────────

interface Series { label: string; color: string; data: Point[] }

function StackedArea({ series, title, unit = '%', maxY = 100, fmtVal }: {
  series: Series[]; title: string; unit?: string; maxY?: number; fmtVal?: (v: number) => string
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [tooltip, setTooltip] = useState<{ x: number; idx: number } | null>(null)

  const base = series.find((s) => s.data.length > 1)
  if (!base) return <NoData label={title} />

  const minT = base.data[0].t, maxT = base.data[base.data.length - 1].t, tRange = maxT - minT || 1
  const xS = (t: number) => PAD.left + ((t - minT) / tRange) * innerW
  const yS = (v: number) => PAD.top + innerH - (Math.min(v, maxY) / maxY) * innerH

  const tickIdxs = [0, 1, 2, 3, 4].map((i) => Math.round((i / 4) * (base.data.length - 1)))
  const fmt = fmtVal ?? ((v: number) => `${v.toFixed(1)}${unit}`)

  const onMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const svgX = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.max(0, Math.min(base.data.length - 1, Math.round(((svgX - PAD.left) / innerW) * (base.data.length - 1))))
    setTooltip({ x: xS(base.data[idx].t), idx })
  }, [base.data]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">{title} — 12h</span>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1 text-[10px]">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: s.color }} />
              <span className="text-zinc-500">{s.label}</span>
            </span>
          ))}
        </div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: `${H}px` }} onMouseMove={onMove} onMouseLeave={() => setTooltip(null)}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.label} id={`sfill-${title}-${s.label}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.5" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.05" />
            </linearGradient>
          ))}
        </defs>

        {[25, 50, 75].map((v) => (
          <g key={v}>
            <line x1={PAD.left} y1={yS(v)} x2={W - PAD.right} y2={yS(v)} stroke="#27272a" strokeWidth="1" />
            <text x={PAD.left - 3} y={yS(v) + 3.5} textAnchor="end" fontSize="8" fill="#52525b">{v}</text>
          </g>
        ))}

        {series.map((s) => {
          if (s.data.length < 2) return null
          const areaPath = `M ${xS(s.data[0].t)} ${PAD.top + innerH} ` + s.data.map((p) => `L ${xS(p.t)} ${yS(p.v)}`).join(' ') + ` L ${xS(s.data[s.data.length - 1].t)} ${PAD.top + innerH} Z`
          const pts = s.data.map((p) => `${xS(p.t)},${yS(p.v)}`).join(' ')
          return (
            <g key={s.label}>
              <path d={areaPath} fill={`url(#sfill-${title}-${s.label})`} />
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth="1.5" strokeLinejoin="round" />
            </g>
          )
        })}

        {tickIdxs.map((i) => <text key={i} x={xS(base.data[i].t)} y={H - 2} textAnchor="middle" fontSize="8" fill="#52525b">{fmtTime(base.data[i].t)}</text>)}

        {tooltip && (
          <g>
            <line x1={tooltip.x} y1={PAD.top} x2={tooltip.x} y2={PAD.top + innerH} stroke="#52525b" strokeWidth="1" strokeDasharray="3 2" />
            {/* Tooltip box */}
            <rect x={Math.min(tooltip.x + 6, W - 120)} y={PAD.top} width="114" height={12 + series.length * 11} rx="4" fill="#18181b" stroke="#3f3f46" strokeWidth="1" />
            <text x={Math.min(tooltip.x + 63, W - 57)} y={PAD.top + 10} textAnchor="middle" fontSize="8" fill="#71717a">{fmtTime(base.data[tooltip.idx].t)}</text>
            {series.map((s, si) => {
              const v = s.data[tooltip.idx]?.v
              return v != null ? (
                <text key={s.label} x={Math.min(tooltip.x + 10, W - 116)} y={PAD.top + 21 + si * 11} fontSize="9" fill={s.color}>
                  {s.label}: {fmt(v)}
                </text>
              ) : null
            })}
          </g>
        )}
      </svg>
    </div>
  )
}

function NoData({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3 flex items-center justify-center" style={{ height: `${H + 32}px` }}>
      <span className="text-xs text-zinc-600">{label} — no data</span>
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function HostMetricsCharts() {
  const [data, setData] = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    fetch('/api/metrics/history')
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(); const id = setInterval(load, 60_000); return () => clearInterval(id) }, [load])

  if (loading) return <div className="flex items-center justify-center h-16 mt-4"><div className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" /></div>
  if (!data) return null

  const toGiB = (pts: Point[]) => pts.map((p) => ({ t: p.t, v: p.v / 1073741824 }))
  const memTotal = data.memBreakdown.total[data.memBreakdown.total.length - 1]?.v ?? 1
  const memMaxGiB = memTotal / 1073741824

  return (
    <div className="space-y-3 mt-4">
      {/* Row 1: overall CPU + RAM sparklines */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Sparkline data={data.cpu} color="#22c55e" fillColor="#22c55e" label="CPU Total" unit="%" />
        <Sparkline data={data.ram} color="#a78bfa" fillColor="#a78bfa" label="RAM Usage" unit="%" />
      </div>

      {/* Row 2: CPU by Mode + Memory Breakdown side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <StackedArea
          title="CPU Usage by Mode"
          unit="%"
          maxY={100}
          series={[
            { label: 'User',   color: '#22c55e', data: data.cpuModes.user   },
            { label: 'System', color: '#f59e0b', data: data.cpuModes.system },
            { label: 'IOWait', color: '#ef4444', data: data.cpuModes.iowait },
            { label: 'Steal',  color: '#a78bfa', data: data.cpuModes.steal  },
          ]}
        />
        <StackedArea
          title="Memory Breakdown"
          unit=" GiB"
          maxY={Math.ceil(memMaxGiB)}
          fmtVal={(v) => `${v.toFixed(2)} GiB`}
          series={[
            { label: 'Used',    color: '#a78bfa', data: toGiB(data.memBreakdown.total.map((p, i) => ({ t: p.t, v: p.v - (data.memBreakdown.available[i]?.v ?? 0) }))) },
            { label: 'Cached',  color: '#06b6d4', data: toGiB(data.memBreakdown.cached)  },
            { label: 'Buffers', color: '#f59e0b', data: toGiB(data.memBreakdown.buffers) },
            { label: 'Free',    color: '#3f3f46', data: toGiB(data.memBreakdown.free)    },
          ]}
        />
      </div>
    </div>
  )
}
