import { getSnapshot } from '../state/store'

const STATE_COLOR: Record<string, string> = {
  AVAILABLE: '#059669', TO_SCENE: '#4F46E5', ON_SCENE: '#D97706', TO_FACILITY: '#4F46E5', HANDOVER: '#D97706',
}
const AMB_WORD: Record<string, string> = {
  AVAILABLE: 'waiting for a call', TO_SCENE: 'rushing to a patient', ON_SCENE: 'treating a patient',
  TO_FACILITY: 'taking patient to hospital', HANDOVER: 'handover at hospital',
}
const URG_WORD: Record<string, string> = { ECHO: 'heart arrest', DELTA: 'serious', CHARLIE: 'urgent', BRAVO: 'moderate', ALPHA: 'minor' }

export default function TelemetryPanel(): JSX.Element {
  const s = getSnapshot()
  if (!s.ready) return <div className="p-6 text-center text-xs text-muted">loading…</div>
  const waiting = s.emgs.filter((e) => e.status === 'QUEUED' || e.status === 'AWAITING_CONFIRM')
  const queueByTier: Record<string, number> = {}
  for (const e of waiting) queueByTier[e.urgency] = (queueByTier[e.urgency] ?? 0) + 1
  const busy = s.ambs.filter((a) => a.state !== 'AVAILABLE').length

  const groups: { tier: string; label: string }[] = [
    { tier: 'DH', label: 'Main Hospitals' },
    { tier: 'CHC', label: 'Health Centres' },
    { tier: 'PHC', label: 'Clinics' },
    { tier: 'HSC', label: 'Health Posts (first aid only)' },
  ]

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3 text-xs">
      <Section title={`Ambulances — ${busy} of ${s.ambs.length} out on a job`}>
        <div className="mb-1.5 flex flex-wrap gap-1 font-mono text-[10px]">
          {Object.entries(AMB_WORD).map(([st, word]) => {
            const n = s.ambs.filter((a) => a.state === st).length
            if (n === 0) return null
            return <span key={st} className="rounded px-1.5 py-0.5" style={{ background: `${STATE_COLOR[st]}18`, color: STATE_COLOR[st] }}>{n} {word}</span>
          })}
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {s.ambs.map((a) => (
            <button key={a.id} title={`${a.callsign}: ${AMB_WORD[a.state]}`} className="rounded-control border p-1 font-mono text-[10px]" style={{ borderColor: STATE_COLOR[a.state], color: STATE_COLOR[a.state] }}>
              {a.callsign}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`Waiting for an ambulance — ${waiting.length}${s.emgsTotal > s.emgs.length ? ` (of ${s.emgsTotal} total)` : ''}`}>
        {waiting.length === 0 ? <div className="text-muted">Nobody is waiting — the fleet is keeping up.</div> : (
          <div className="flex flex-wrap gap-1.5 font-mono">
            {Object.entries(queueByTier).sort((a, b) => (a[0] > b[0] ? 1 : -1)).map(([tier, n]) => (
              <span key={tier} className="rounded bg-bg px-1.5 py-0.5">{URG_WORD[tier] ?? tier} ×{n}</span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Hospitals — beds free · medicines in stock">
        <div className="flex flex-col gap-2.5">
          {groups.map((g) => {
            const list = s.facilities.filter((f) => f.tier === g.tier)
            if (list.length === 0) return null
            return (
              <div key={g.tier}>
                <div className="mb-1 font-display text-[10px] font-semibold uppercase tracking-wide text-muted">{g.label}</div>
                <div className="flex flex-col gap-1">
                  {list.map((f) => (
                    <div key={f.id} className="flex items-center gap-2" title={`${f.name}: ${f.bedsFree} of ${f.bedsTotal} beds free · ${f.medStock} medicine doses in stock`}>
                      <span className="w-28 shrink-0 truncate">{f.name}</span>
                      {f.bedsTotal === 0 ? (
                        <span className="flex-1 text-[10px] text-muted">no beds — first aid & referral only</span>
                      ) : (
                        <>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.round((f.bedsFree / f.bedsTotal) * 100)}%`, background: f.bedsFree / f.bedsTotal > 0.5 ? '#059669' : f.bedsFree / f.bedsTotal > 0.2 ? '#D97706' : '#DC2626' }}
                            />
                          </div>
                          <span className="w-12 shrink-0 text-right font-mono tnum">{f.bedsFree}/{f.bedsTotal} beds</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
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
