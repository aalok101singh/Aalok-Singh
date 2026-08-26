import { useEffect, useMemo } from 'react'
import { getSnapshot } from '../state/store'

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// urgency tiers (D3: these were facility tiers before — every number read 100%/00:00)
const URGENCIES: { key: string; label: string }[] = [
  { key: 'ECHO', label: 'Heart arrest' },
  { key: 'DELTA', label: 'Serious' },
  { key: 'CHARLIE', label: 'Urgent' },
  { key: 'BRAVO', label: 'Moderate' },
  { key: 'ALPHA', label: 'Minor' },
]

interface Highlight { label: string; text: string }

export default function ReportCard({ onClose }: { onClose: () => void }): JSX.Element {
  const s = getSnapshot()
  const k = s.kpis
  const seed = Number(new URLSearchParams(location.search).get('seed') ?? 42)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const highlights = useMemo<Highlight[]>(() => {
    const out: Highlight[] = []
    let biggestSave: { gap: number; text: string } | null = null
    let closestCall: { gap: number; text: string } | null = null
    for (const tr of s.traces) {
      const eligible = tr.evals.filter((e) => e.eligible).sort((a, b) => a.totalS - b.totalS)
      if (eligible.length < 2) continue
      const gap = eligible[1].totalS - eligible[0].totalS
      const facName = (id: number): string => getSnapshot().facilities.find((f) => f.id === id)?.name ?? `#${id}`
      const text = `chose ${facName(tr.chosenId)} over ${facName(eligible[1].facilityId)} (+${mmss(gap)} slower)`
      if (!biggestSave || gap > biggestSave.gap) biggestSave = { gap, text }
      if (!closestCall || gap < closestCall.gap) closestCall = { gap, text }
    }
    if (biggestSave) out.push({ label: 'Biggest save', text: biggestSave.text })
    if (closestCall) out.push({ label: 'Closest call', text: closestCall.text })
    if (k) {
      const breached = URGENCIES.filter((u) => (k.slaPct[u.key] ?? 100) < 100).map((u) => u.label)
      if (breached.length > 0) out.push({ label: 'Missed targets', text: breached.join(', ') })
    }
    return out.slice(0, 3)
  }, [s.traces, k])

  const cost = k?.costSum
  const totalS = cost ? cost.responseS + cost.onSceneS + cost.transportS + cost.waitS : 0

  return (
    <div className="print-target absolute inset-0 z-40 flex items-center justify-center bg-ink/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="max-h-[92%] w-[580px] overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <div className="font-display text-lg font-bold">CareGrid — District EMS Report</div>
            <div className="text-xs text-muted">Baran district, Rajasthan · how did the system do?</div>
          </div>
          <button className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-ink print:hidden" onClick={onClose}>✕</button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm tnum">
          <Row k="Scenario" v={s.scenario} />
          <Row k="Simulated time" v={mmss(s.clockS)} />
          <Row k="Patients delivered" v={String(k?.missionsCompleted ?? 0)} />
          <Row k="Fleet busy" v={`${k?.utilization ?? 0}%`} />
          <Row k="Map seed" v={String(seed)} />
          <Row k="Road network" v={s.worldStats ? `${s.worldStats.nodeCount.toLocaleString()} junctions` : '—'} />
        </div>

        <Section title="How fast did ambulances arrive? (on-time % per urgency)">
          <div className="grid grid-cols-5 gap-2">
            {URGENCIES.map((u) => {
              const pct = k?.slaPct?.[u.key] ?? 100
              return (
                <div key={u.key} className={`rounded border p-2 text-center ${pct >= 90 ? 'border-ok/30 bg-ok-soft' : pct >= 70 ? 'border-warn/30 bg-warn-soft' : 'border-danger/30 bg-danger-soft'}`}>
                  <div className="font-display text-[10px] font-semibold leading-tight">{u.label}</div>
                  <div className={`font-mono text-sm tnum ${pct >= 90 ? 'text-ok' : pct >= 70 ? 'text-warn' : 'text-danger'}`}>{Math.round(pct)}%</div>
                </div>
              )
            })}
          </div>
        </Section>

        <Section title="Arrival times (half arrived within P50 · 9 in 10 within P90)">
          <div className="grid grid-cols-5 gap-2">
            {URGENCIES.map((u) => (
              <div key={u.key} className="rounded border border-border bg-bg p-2 text-center">
                <div className="font-display text-[10px] font-semibold leading-tight">{u.label}</div>
                <div className="font-mono text-[11px] tnum">½ in {k ? mmss(k.p50ByTier?.[u.key] ?? 0) : '—'}</div>
                <div className="font-mono text-[11px] tnum text-muted">9/10 in {k ? mmss(k.p90ByTier?.[u.key] ?? 0) : '—'}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Where the time went (all missions combined)">
          <div className="grid grid-cols-4 gap-2 font-mono text-xs tnum">
            <CostCell label="Driving to patient" sec={cost?.responseS ?? 0} />
            <CostCell label="Treating on scene" sec={cost?.onSceneS ?? 0} />
            <CostCell label="Drive to hospital" sec={cost?.transportS ?? 0} />
            <CostCell label="Hospital handover" sec={cost?.waitS ?? 0} />
          </div>
          <div className="mt-1 text-right font-mono text-xs text-muted tnum">
            total {mmss(totalS)} of ambulance time
          </div>
        </Section>

        <Section title="Sharpest decisions">
          {highlights.length === 0 && <div className="text-xs text-muted">No dispatches yet.</div>}
          {highlights.map((h) => (
            <div key={h.label} className="mt-1 flex gap-2 text-xs">
              <span className="w-28 shrink-0 font-display font-semibold">{h.label}</span>
              <span className="text-muted">{h.text}</span>
            </div>
          ))}
        </Section>

        <button className="mt-4 rounded border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg print:hidden" onClick={() => window.print()}>
          Print report
        </button>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-border/60 py-0.5">
      <span className="text-muted">{k}</span>
      <b>{v}</b>
    </div>
  )
}

function CostCell({ label, sec }: { label: string; sec: number }): JSX.Element {
  return (
    <div className="rounded border border-border bg-bg p-2 text-center">
      <div className="text-[10px] leading-tight text-muted">{label}</div>
      <b>{mmss(sec)}</b>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mt-4 break-inside-avoid">
      <div className="mb-1.5 font-display text-xs font-semibold uppercase tracking-wide text-muted">{title.trim()}</div>
      {children}
    </div>
  )
}
