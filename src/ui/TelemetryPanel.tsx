import { getSnapshot } from '../state/store'

const STATE_COLOR: Record<string, string> = {
  AVAILABLE: '#059669', TO_SCENE: '#4F46E5', ON_SCENE: '#D97706', TO_FACILITY: '#4F46E5', HANDOVER: '#D97706',
}

export default function TelemetryPanel(): JSX.Element {
  const s = getSnapshot()
  if (!s.ready) return <div className="p-6 text-center text-xs text-muted">loading…</div>
  const queueByTier: Record<string, number> = {}
  for (const e of s.emgs) {
    if (e.status === 'QUEUED' || e.status === 'AWAITING_CONFIRM') queueByTier[e.urgency] = (queueByTier[e.urgency] ?? 0) + 1
  }
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3 text-xs">
      <Section title="fleet">
        <div className="grid grid-cols-6 gap-1.5">
          {s.ambs.map((a) => (
            <button key={a.id} title={`${a.callsign} · ${a.state}`} className="rounded-control border p-1 font-mono text-[10px]" style={{ borderColor: STATE_COLOR[a.state], color: STATE_COLOR[a.state] }}>
              {a.callsign}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`triage queue — ${Object.values(queueByTier).reduce((a, b) => a + b, 0)} waiting`}>
        {Object.entries(queueByTier).length === 0 ? <div className="text-muted">clear</div> : (
          <div className="flex gap-2 font-mono">
            {Object.entries(queueByTier).map(([tier, n]) => (
              <span key={tier} className="rounded bg-bg px-1.5 py-0.5">{tier} ×{n}</span>
            ))}
          </div>
        )}
      </Section>

      <Section title={`facilities — ${s.ambs.filter((a) => a.state !== 'AVAILABLE').length} units busy`}>
        <div className="flex flex-col gap-1.5">
          {s.facilities.map((f) => {
            const pct = f.bedsTotal === 0 ? 100 : Math.round(((f.bedsTotal - f.bedsFree) / f.bedsTotal) * 100)
            const col = pct > 80 ? '#DC2626' : pct > 50 ? '#D97706' : '#059669'
            return (
              <div key={f.id} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate">{f.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: col }} />
                </div>
                <span className="w-10 shrink-0 text-right font-mono tnum">{f.bedsFree}/{f.bedsTotal}</span>
              </div>
            )
          })}
        </div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 font-display text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  )
}
