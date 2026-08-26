import { useRef } from 'react'
import { actions, getSnapshot } from '../state/store'

const TRIGGERS: { label: string; action: string; title: string; danger?: boolean }[] = [
  { label: 'Heart-arrest call', action: 'INJECT_ECHO', danger: true, title: 'Worst case: must arrive in 8 min. Auto-dispatched by protocol — watch the red pulsing patient.' },
  { label: 'Serious emergency', action: 'INJECT_DELTA', danger: true, title: 'The standard 15-min emergency. Great with follow-cam.' },
  { label: 'Urgent but stable', action: 'INJECT_CHARLIE', title: '30-min target — fills the queue realistically.' },
  { label: '8 calls at once', action: 'MASS_INFLUX_8', danger: true, title: 'Small surge: watch calls queue up and batch assignment pick the best mix.' },
  { label: '1,000 calls at once', action: 'STRESS_SURGE_1000', danger: true, title: 'Stress test: the list caps at 50 cards, nothing crashes.' },
  { label: 'Block road on a mission', action: 'CLOSE_RANDOM_ROAD', title: 'Closes a road on an active ambulance\'s route — it reroutes around it live.' },
  { label: 'Road collapses under ambulance', action: 'SEVER_ACTIVE_MISSION_ROAD', danger: true, title: 'Always the road right in front of a moving ambulance.' },
  { label: 'Reopen all roads', action: 'REOPEN_ALL', title: 'Clears every closure instantly.' },
  { label: 'Heavy rain', action: 'WEATHER_SPIKE', title: 'Monsoon: every drive becomes 1.5× slower in 3 zones.' },
  { label: 'Fill a clinic\'s beds', action: 'DRAIN_BEDS_CHC', title: 'A clinic goes full — new patients are sent farther away.' },
  { label: 'Empty a clinic\'s medicines', action: 'DEPLETE_MEDS_PHC', title: 'A clinic runs out of stock — the engine rejects it (NO MEDS).' },
  { label: 'Specialist leaves duty', action: 'FORCE_SPECIALIST_OFFSHIFT', title: 'Forces the engine to choose a farther hospital that still has the right doctor.' },
  { label: 'Same call reported 3×', action: 'DUPLICATE_STORM', title: 'Duplicates merge into one within a 2-minute window.' },
]

export default function ChaosPanel(): JSX.Element {
  const s = getSnapshot()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const fire = (action: string, el: HTMLElement): void => {
    actions.chaos(action)
    el.blur()
    if (detailsRef.current) detailsRef.current.open = false
  }
  return (
    <details ref={detailsRef} className="absolute bottom-3 left-3 z-10 w-72 rounded-card border border-border bg-surface shadow-card">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold">
        What-if drills — {s.emgs.length} active
      </summary>
      <div className="flex max-h-[46vh] flex-wrap gap-1.5 overflow-y-auto border-t border-border p-2">
        <div className="w-full px-0.5 pb-1 text-[10px] leading-snug text-muted">
          Click a drill, then watch the map + the feed react. Turn “background arrivals” off first to test one thing at a time.
        </div>
        {TRIGGERS.map((tr) => (
          <button
            key={tr.action}
            title={tr.title}
            className={`rounded-control border px-2 py-1 text-[10px] font-medium ${tr.danger ? 'border-danger/40 bg-danger-soft text-danger hover:opacity-80' : 'border-border hover:bg-bg'}`}
            onClick={(e) => fire(tr.action, e.currentTarget)}
          >
            {tr.label}
          </button>
        ))}
        <button
          className={`rounded-control border px-2 py-1 text-[10px] font-medium ${s.ambientOn ? 'border-primary bg-primary-soft text-primary' : 'border-border'}`}
          onClick={(e) => { actions.ambient(!s.ambientOn); e.currentTarget.blur() }}
          title="Background emergencies arrive on their own, like real life. Turn off to test a single drill in isolation."
        >
          background arrivals: {s.ambientOn ? 'on' : 'off'}
        </button>
        <button
          className="w-full rounded-control border border-primary px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary-soft"
          onClick={(e) => { actions.chaos('RESET_SCENARIO'); e.currentTarget.blur(); if (detailsRef.current) detailsRef.current.open = false }}
          title="Reset the clock, fleet, beds and medicines to a fresh start"
        >
          Reset everything (same map)
        </button>
      </div>
    </details>
  )
}
