import { actions, getSnapshot } from '../state/store'

const TRIGGERS: { label: string; action: string; danger?: boolean }[] = [
  { label: 'Inject ECHO', action: 'INJECT_ECHO', danger: true },
  { label: 'Inject DELTA', action: 'INJECT_DELTA', danger: true },
  { label: 'Inject CHARLIE', action: 'INJECT_CHARLIE' },
  { label: 'Mass influx ×8', action: 'MASS_INFLUX_8', danger: true },
  { label: 'Stress surge ×1000', action: 'STRESS_SURGE_1000', danger: true },
  { label: 'Close random road', action: 'CLOSE_RANDOM_ROAD' },
  { label: "Sever active mission's road", action: 'SEVER_ACTIVE_MISSION_ROAD' },
  { label: 'Reopen all roads', action: 'REOPEN_ALL' },
  { label: 'Weather spike', action: 'WEATHER_SPIKE' },
  { label: 'Drain beds @ random CHC', action: 'DRAIN_BEDS_CHC' },
  { label: 'Deplete meds @ random PHC', action: 'DEPLETE_MEDS_PHC' },
  { label: 'Force specialist off-shift', action: 'FORCE_SPECIALIST_OFFSHIFT' },
  { label: 'Duplicate-request storm ×3', action: 'DUPLICATE_STORM' },
]

export default function ChaosPanel(): JSX.Element {
  const s = getSnapshot()
  return (
    <details className="absolute bottom-3 left-3 z-10 w-72 rounded-card border border-border bg-surface shadow-card">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold">Chaos Panel — {s.emgs.length} active</summary>
      <div className="flex flex-wrap gap-1.5 border-t border-border p-2">
        {TRIGGERS.map((tr) => (
          <button
            key={tr.action}
            className={`rounded-control border px-2 py-1 text-[10px] font-medium ${tr.danger ? 'border-danger/40 bg-danger-soft text-danger hover:opacity-80' : 'border-border hover:bg-bg'}`}
            onClick={() => actions.chaos(tr.action)}
          >
            {tr.label}
          </button>
        ))}
        <button
          className="w-full rounded-control border border-primary px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary-soft"
          onClick={() => actions.chaos('RESET_SCENARIO')}
        >
          Reset scenario (seed)
        </button>
      </div>
    </details>
  )
}
