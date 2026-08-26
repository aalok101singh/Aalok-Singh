import { useEffect, useRef, useState } from 'react'
import TopBar from './ui/TopBar'
import DirectorBar from './ui/DirectorBar'
import MapCanvas from './ui/MapCanvas'
import RequestFeed from './ui/RequestFeed'
import TelemetryPanel from './ui/TelemetryPanel'
import DecisionLog from './ui/DecisionLog'
import ChaosPanel from './ui/ChaosPanel'
import BenchmarkTab from './ui/BenchmarkTab'
import KpiStrip from './ui/KpiStrip'
import ShortcutsModal from './ui/ShortcutsModal'
import { actions, ensureWorker, getSnapshot, subscribe } from './state/store'
import { t } from './i18n/t'

type Tab = 'requests' | 'telemetry' | 'decisions' | 'benchmarks'

function useSnapshot() {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((n) => n + 1)), [])
  return getSnapshot()
}

export default function App(): JSX.Element {
  const s = useSnapshot()
  const [tab, setTab] = useState<Tab>('requests')
  const booted = useRef(false)
  useEffect(() => {
    if (!booted.current) {
      booted.current = true
      ensureWorker()
    }
  }, [])

  // keyboard shortcuts (§10.2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      switch (e.key) {
        case ' ': e.preventDefault(); s.running ? actions.pause() : actions.start(); break
        case '1': actions.speed(1); break
        case '2': actions.speed(2); break
        case '3': actions.speed(5); break
        case 'e': case 'E': actions.chaos('INJECT_ECHO'); break
        case 'd': actions.chaos('INJECT_DELTA'); break
        case 'm': case 'M': actions.mode(!getSnapshot().manual); break
        case 'f': case 'F': window.dispatchEvent(new CustomEvent('caregrid:follow')); break
        case 'w': case 'W': actions.wavefront(!getSnapshot().wavefrontOn); break
        case '?': window.dispatchEvent(new CustomEvent('caregrid:shortcuts')); break
        case '+': window.dispatchEvent(new CustomEvent('caregrid:zoom', { detail: 1.2 })); break
        case '-': window.dispatchEvent(new CustomEvent('caregrid:zoom', { detail: 0.8 })); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.running])

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar />
      <DirectorBar />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <MapCanvas />
          <ChaosPanel />
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
      <ShortcutsModal />
      <div aria-live="polite" className="sr-only">{s.ariaAnnounce}</div>
    </div>
  )
}


