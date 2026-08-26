import { useEffect, useState } from 'react'
import { actions, getSnapshot } from '../state/store'
import { t } from '../i18n/t'

const URGENCY_COLOR: Record<string, string> = {
  ECHO: '#DC2626', DELTA: '#EA580C', CHARLIE: '#D97706', BRAVO: '#0284C7', ALPHA: '#64748B',
}
const GLYPH: Record<string, string> = { ECHO: '▲', DELTA: '●', CHARLIE: '■', BRAVO: '◆', ALPHA: '○' }

export default function RequestFeed(): JSX.Element {
  const s = getSnapshot()
  const [selected, setSelected] = useState<number | null>(null)
  const [nowS, setNowS] = useState(s.clockS)
  useEffect(() => { setNowS(getSnapshot().clockS) }, [s.clockS])

  if (s.emgs.length === 0) return <Empty text="no active requests" />

  return (
    <div className="flex flex-col gap-2 overflow-y-auto p-3">
      {[...s.emgs].reverse().map((e) => {
        const elapsed = nowS - e.filedAtS
        const frac = Math.min(1, Math.max(0.02, elapsed / e.slaS))
        const breached = elapsed > e.slaS
        const awaiting = e.status === 'AWAITING_CONFIRM'
        return (
          <div key={e.id}>
            <button
              className={`w-full rounded-card border bg-surface p-2.5 text-left shadow-card ${awaiting ? 'border-warn' : 'border-border'}`}
              onClick={() => {
                if (awaiting && s.manual) setSelected(selected === e.id ? null : e.id)
              }}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm" style={{ color: URGENCY_COLOR[e.urgency] }}>{GLYPH[e.urgency]}</span>
                <span className="font-medium">{e.villageName}</span>
                <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ background: URGENCY_COLOR[e.urgency] }}>{e.urgency}</span>
                {e.bestEffort && <span title="SLA impossible" className="text-warn">⚠</span>}
                <span className="ml-auto font-mono text-xs tnum text-muted">
                  {breached ? `⚠ ${t('sla.breach')}` : `${Math.max(0, Math.floor((e.slaS - elapsed) / 60))}:${String(Math.max(0, 60 - (Math.floor(elapsed) % 60)))} to SLA`}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                <span>{t(`caller.${e.caller}`)}</span>·<span>{t(`status.${e.status}`)}</span>
                {e.urgency === 'ECHO' && <span className="ml-auto rounded bg-bg px-1 text-[10px]">auto (ECHO protocol)</span>}
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg">
                <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: breached ? '#DC2626' : URGENCY_COLOR[e.urgency] }} />
              </div>
            </button>
            {awaiting && selected === e.id && <RecommendationCard emgId={e.id} onDone={() => setSelected(null)} />}
          </div>
        )
      })}
    </div>
  )
}

function RecommendationCard({ emgId, onDone }: { emgId: number; onDone: () => void }): JSX.Element {
  const s = getSnapshot()
  const rec = s.recommendation
  useEffect(() => { actions.recommend(emgId) }, [emgId])
  return (
    <div className="mt-1 rounded-card border border-primary bg-primary-soft p-2.5 shadow-card">
      <div className="mb-1 text-xs font-semibold text-primary">engine recommendation</div>
      {!rec || rec.emgId !== emgId ? (
        <div className="font-mono text-xs text-muted">computing…</div>
      ) : (
        <>
          <div className="font-mono text-xs leading-relaxed">
            ✔ {t('log.chosen')}: facility #{rec.chosenId} — {rec.summary}
          </div>
          <div className="mt-1 text-xs text-muted">
            ↳ {rec.ambCallsign} · response {Math.floor(rec.ambTravelS / 60)}:{String(rec.ambTravelS % 60).padStart(2, '0')}
          </div>
          <div className="mt-1 text-[10px] text-muted">
            ✖ {rec.evals.filter((ev) => !ev.eligible).map((ev) => `#${ev.facilityId} ${ev.reject}`).join(' · ') || 'all eligible'}
          </div>
          <button
            className="mt-2 w-full rounded-control bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            onClick={() => { actions.confirm(emgId); onDone() }}
          >
            {t('action.dispatch')} (escalates at 80% SLA)
          </button>
        </>
      )}
    </div>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="p-6 text-center text-xs text-muted">{text}</div>
}
