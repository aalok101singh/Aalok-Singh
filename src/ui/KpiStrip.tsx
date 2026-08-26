import { getSnapshot } from '../state/store'

function mmss(sec: number): string {
  if (!isFinite(sec) || sec === 0 && arguments.length === 0) return '—'
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function KpiStrip(): JSX.Element {
  const s = getSnapshot()
  const k = s.kpis
  const p50 = k?.p50ByTier?.DELTA ?? 0
  const p90 = k?.p90ByTier?.DELTA ?? 0
  const sla = k ? Math.round(Object.values(k.slaPct).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(k.slaPct).length)) : 100
  const util = k?.utilization ?? 0
  return (
    <div className="flex h-12 items-center gap-5 border-t border-border bg-surface px-4 font-mono text-sm tnum">
      <span className="font-display text-xs font-semibold uppercase tracking-wide text-muted">KPI</span>
      <Metric label="P50" value={mmss(p50)} />
      <Metric label="P90" value={mmss(p90)} />
      <Metric label="SLA" value={`${sla}%`} good={sla >= 90} />
      <Metric label="Util" value={`${util}%`} />
      <Metric label="missions" value={String(k?.missionsCompleted ?? 0)} />
      <button
        className="ml-auto rounded border border-border px-2 py-1 text-xs font-medium text-muted hover:text-primary"
        onClick={() => window.dispatchEvent(new CustomEvent('caregrid:report'))}
      >
        Report (R)
      </button>
    </div>
  )
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }): JSX.Element {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <b className={good === false ? 'text-danger' : good === true ? 'text-ok' : ''}>{value}</b>
    </span>
  )
}
