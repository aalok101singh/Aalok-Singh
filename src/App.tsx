import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import TopBar from './ui/TopBar'
import DirectorBar from './ui/DirectorBar'
import MapCanvas from './ui/MapCanvas'
import RequestFeed from './ui/RequestFeed'
import TelemetryPanel from './ui/TelemetryPanel'
import DecisionLog from './ui/DecisionLog'
import ChaosPanel from './ui/ChaosPanel'
import BenchmarkTab from './ui/BenchmarkTab'
import KpiStrip from './ui/KpiStrip'
import ReportCard from './ui/ReportCard'
import ShortcutsModal from './ui/ShortcutsModal'
import { actions, ensureWorker, getSnapshot, subscribe } from './state/store'
import { t } from './i18n/t'

type Tab = 'requests' | 'telemetry' | 'decisions' | 'benchmarks'

function useSnapshot() {
  useSyncExternalStore(subscribe, getSnapshot) // D44: tearing-safe, no full-tree counter re-render
  return getSnapshot()
}

export default function App(): JSX.Element {
  const s = useSnapshot()
  const [tab, setTab] = useState<Tab>('requests')
  const [reportOpen, setReportOpen] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const lastEventId = useRef(-1)
  const lastScenarioEnd = useRef(-1)
  useEffect(() => {
    const last = s.events[s.events.length - 1]
    if (last && last.id !== lastEventId.current) {
      lastEventId.current = last.id
      setToast({ id: last.id, text: last.text })
      const t = setTimeout(() => setToast(null), 4500)
      return () => clearTimeout(t)
    }
  }, [s.events])
  const booted = useRef(false)
  useEffect(() => {
    if (!booted.current) {
      booted.current = true
      ensureWorker()
    }
  }, [])

  useEffect(() => {
    const onReport = (): void => setReportOpen(true)
    const onReportToggle = (): void => setReportOpen((o) => !o)
    const onDismiss = (): void => { setReportOpen(false); window.dispatchEvent(new CustomEvent('caregrid:shortcuts-dismiss')) }
    window.addEventListener('caregrid:report', onReport)
    window.addEventListener('caregrid:report-toggle', onReportToggle)
    window.addEventListener('caregrid:dismiss', onDismiss)
    return () => {
      window.removeEventListener('caregrid:report', onReport)
      window.removeEventListener('caregrid:report-toggle', onReportToggle)
      window.removeEventListener('caregrid:dismiss', onDismiss)
    }
  }, [])

  // keyboard shortcuts (§10.2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === ' ' && tag === 'BUTTON') (e.target as HTMLElement).blur() // Space toggles pause, never re-fires the button (D18)
      if (e.key === 'Escape') {
        window.dispatchEvent(new CustomEvent('caregrid:dismiss'))
        return
      }
      switch (e.key) {
        case ' ': e.preventDefault(); s.running ? actions.pause() : actions.start(); break
        case '1': actions.speed(1); break
        case '2': actions.speed(60); break
        case '3': actions.speed(90); break
        case 'e': case 'E': actions.chaos('INJECT_DELTA'); break
        case 'd': case 'D': actions.chaos('INJECT_ECHO'); break
        case 'm': case 'M': actions.mode(!getSnapshot().manual); break
        case 'f': case 'F': window.dispatchEvent(new CustomEvent('caregrid:follow')); break
        case 'w': case 'W': actions.wavefront(!getSnapshot().wavefrontOn); break
        case 'r': case 'R': window.dispatchEvent(new CustomEvent('caregrid:report-toggle')); break
        case '?': window.dispatchEvent(new CustomEvent('caregrid:shortcuts')); break
        case '+': case '=': window.dispatchEvent(new CustomEvent('caregrid:zoom', { detail: 1.2 })); break
        case '-': case '_': window.dispatchEvent(new CustomEvent('caregrid:zoom', { detail: 0.8 })); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.running])

  // scenario end → auto-open the report card (checklist item 15)
  useEffect(() => {
    const end = s.events.find((ev) => ev.text.startsWith('SCENARIO_END'))
    if (end && end.id !== lastScenarioEnd.current) {
      lastScenarioEnd.current = end.id
      setReportOpen(true)
    }
  }, [s.events])

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar />
      <DirectorBar />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <MapCanvas />
          <ChaosPanel />
          {toast && (
            <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-card border border-border bg-surface px-3 py-1.5 text-xs shadow-card">
              {toast.text}
            </div>
          )}
          {!s.ready && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 font-display text-sm">
              building district graph…
            </div>
          )}
        </div>
        <div className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex border-b border-border">
            {(['requests', 'telemetry', 'decisions', 'benchmarks'] as Tab[]).map((tb) => (
              <button
                key={tb}
                className={`px-3 py-2 text-xs font-medium ${tab === tb ? 'border-b-2 border-primary text-primary' : 'text-muted hover:text-ink'}`}
                onClick={() => setTab(tb)}
              >
                {t(`tab.${tb}`)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'requests' && <RequestFeed />}
            {tab === 'telemetry' && <TelemetryPanel />}
            {tab === 'decisions' && <DecisionLog />}
            {tab === 'benchmarks' && <BenchmarkTab />}
          </div>
        </div>
      </div>
      <KpiStrip />
      {reportOpen && <ReportCard onClose={() => setReportOpen(false)} />}
      <ShortcutsModal />
      <div aria-live="polite" className="sr-only">{s.ariaAnnounce}</div>
    </div>
  )
}


