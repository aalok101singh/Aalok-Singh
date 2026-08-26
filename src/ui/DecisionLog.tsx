import { getSnapshot } from '../state/store'
import { t } from '../i18n/t'

const URGENCY_COLOR: Record<string, string> = {
  ECHO: '#DC2626', DELTA: '#EA580C', CHARLIE: '#D97706', BRAVO: '#0284C7', ALPHA: '#64748B',
}

function clock(tS: number): string {
  const h = Math.floor(tS / 3600), m = Math.floor((tS % 3600) / 60), sec = Math.floor(tS % 60)
  return `${String((8 + h) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** §10.5 DecisionLog — the 40% criterion made visible. One card per dispatch, newest first. */
export default function DecisionLog(): JSX.Element {
  const s = getSnapshot()
  const traces = [...s.traces].reverse()
  if (traces.length === 0) return <div className="p-6 text-center text-xs text-muted">no dispatches yet — run a Director scenario</div>
  return (
    <div className="flex flex-col gap-2 overflow-y-auto p-3">
      {traces.map((tr) => {
        const emg = s.emgs.find((e) => e.id === tr.emgId)
        const chosen = s.facilities.find((f) => f.id === tr.chosenId)
        return (
          <div key={`${tr.emgId}-${tr.summary.slice(0, 12)}`} className="rounded-card border border-border bg-surface p-2.5 font-mono text-xs shadow-card">
            <div className="flex items-center gap-2">
              <span style={{ color: URGENCY_COLOR[emg?.urgency ?? 'ALPHA'] }}>●</span>
              <span className="tnum">{clock(s.events.find((e) => e.emgId === tr.emgId)?.tS ?? s.clockS)}</span>
              <span className="font-semibold" style={{ color: URGENCY_COLOR[emg?.urgency ?? 'ALPHA'] }}>{emg?.urgency}</span>
              <span>{emg?.villageName ?? `#${tr.emgId}`}</span>
              {emg && <span className="text-muted">({emg.need.toLowerCase()})</span>}
            </div>
            <div className="mt-1">
              ✔ {t('log.chosen')}: <b>{chosen?.name ?? `facility #${tr.chosenId}`}</b>
            </div>
            <div className="text-muted">↳ {tr.summary}</div>
            {tr.evals.filter((ev) => !ev.eligible).slice(0, 4).map((ev) => (
              <div key={ev.facilityId} className="text-danger/80">
                ✖ {s.facilities.find((f) => f.id === ev.facilityId)?.name ?? `#${ev.facilityId}`} — {reasonText(ev.reject)}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function reasonText(reject?: string): string {
  if (!reject) return t('log.rejected')
  if (reject === 'NO_SPECIALTY') return t('reason.NO_SPECIALTY', 'no specialist on duty', { spec: '' })
  if (reject === 'NO_BEDS') return t('reason.NO_BEDS', 'beds full')
  if (reject === 'NO_MEDS') return t('reason.NO_MEDS', 'stock low', { drug: '' })
  return t('reason.UNREACHABLE', 'no road route')
}
