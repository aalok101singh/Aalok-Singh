import { getSnapshot } from '../state/store'

const URGENCY_COLOR: Record<string, string> = {
  ECHO: '#DC2626', DELTA: '#EA580C', CHARLIE: '#D97706', BRAVO: '#0284C7', ALPHA: '#64748B',
}
const URG_WORD: Record<string, string> = { ECHO: 'heart arrest', DELTA: 'serious', CHARLIE: 'urgent', BRAVO: 'moderate', ALPHA: 'minor' }

function clock(tS: number): string {
  const h = Math.floor(tS / 3600), m = Math.floor((tS % 3600) / 60), sec = Math.floor(tS % 60)
  return `${String((8 + h) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** §10.5 — one card per dispatch: who was sent where, why, and what was rejected. Newest first. */
export default function DecisionLog(): JSX.Element {
  const s = getSnapshot()
  const traces = [...s.traces].reverse()
  if (traces.length === 0) return <div className="p-6 text-center text-xs text-muted">no dispatches yet — run a scenario above</div>
  return (
    <div className="flex flex-col gap-2 overflow-y-auto p-3">
      {traces.map((tr) => {
        const emg = s.emgs.find((e) => e.id === tr.emgId)
        const chosen = s.facilities.find((f) => f.id === tr.chosenId)
        const parts = tr.summary.split('=')[1]?.split('·') ?? []
        const total = parts[0]?.trim() ?? '—'
        const breakdown = parts.slice(1).join('·').trim()
        return (
          <div key={`${tr.emgId}-${tr.summary.slice(0, 12)}-${tr.ambCallsign}`} className="rounded-card border border-border bg-surface p-2.5 text-xs shadow-card">
            <div className="flex items-center gap-2">
              <span style={{ color: URGENCY_COLOR[emg?.urgency ?? 'ALPHA'] }}>●</span>
              <span className="tnum text-muted">{clock(s.events.find((e) => e.emgId === tr.emgId)?.tS ?? s.clockS)}</span>
              <span className="font-medium">{emg?.villageName ?? `call #${tr.emgId}`}</span>
              {emg && <span className="text-muted">({URG_WORD[emg.urgency] ?? emg.urgency} · needs {emg.need.toLowerCase()})</span>}
            </div>
            <div className="mt-1">
              ✔ Sent <b>{tr.ambCallsign}</b> to <b>{chosen?.name ?? `facility #${tr.chosenId}`}</b> — <span className="font-mono tnum">{total}</span> door-to-hospital
            </div>
            <div className="text-[11px] text-muted">↳ {breakdown}</div>
            {(() => {
              const facById = new Map(s.facilities.map((f) => [f.id, f]))
              const rejects = tr.evals.filter((ev) => !ev.eligible)
                .sort((a, b) => (facById.get(a.facilityId)?.tier === 'PHC' ? 0 : 1) - (facById.get(b.facilityId)?.tier === 'PHC' ? 0 : 1)) // nearby clinic rejection first
                .slice(0, 3)
              return rejects.map((ev) => (
                <div key={ev.facilityId} className="text-danger/80">
                  ✖ {facById.get(ev.facilityId)?.name ?? `#${ev.facilityId}`} — {reasonText(ev.reject)}
                </div>
              ))
            })()}
          </div>
        )
      })}
    </div>
  )
}

function reasonText(reject?: string): string {
  if (reject === 'NO_SPECIALTY') return 'no right doctor on duty now'
  if (reject === 'NO_BEDS') return 'beds full'
  if (reject === 'NO_MEDS') return 'medicines out of stock'
  if (reject === 'UNREACHABLE') return 'no road route'
  return 'not suitable'
}
