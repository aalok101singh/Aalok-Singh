// ~60-line event store (D4): worker diffs -> snapshot -> useSyncExternalStore.
import type { DecisionTrace } from '../engine/types'
import type { AmbDelta, BenchResult, CompletedView, EmgView, FacDelta, FromWorker, KpiView, WorldStats } from '../worker/protocol'
import { setLang } from '../i18n/t'

export interface SimEventView { id: number; tS: number; kind: string; text: string; emgId?: number }

export interface Snapshot {
  ready: boolean
  worldStats: WorldStats | null
  facilities: { id: number; name: string; tier: string; bedsFree: number; bedsTotal: number; medStock: number }[]
  clockS: number
  running: boolean
  speedMult: number
  manual: boolean
  ambs: AmbDelta[]
  emgs: EmgView[]
  emgsTotal: number
  facDeltas: FacDelta[]
  events: SimEventView[]
  traces: DecisionTrace[]
  kpis: KpiView | null
  completed: CompletedView[]
  closedEdges: number[]
  recommendation: DecisionTrace | null
  bench: BenchResult | null
  wavefrontOn: boolean
  ariaAnnounce: string
  scenario: string
  batchOptimalOn: boolean
  ambientOn: boolean
  lang: 'en' | 'hi'
}

const initial: Snapshot = {
  ready: false, worldStats: null, facilities: [], clockS: 0,
  running: false, speedMult: 1, manual: false,
  ambs: [], emgs: [], emgsTotal: 0, facDeltas: [], events: [], traces: [],
  kpis: null, completed: [], closedEdges: [], recommendation: null, bench: null,
  wavefrontOn: false, ariaAnnounce: '', scenario: 'Free run', batchOptimalOn: true, ambientOn: false,
  lang: 'en',
}

let snap: Snapshot = initial
const listeners = new Set<() => void>()
let worker: Worker | null = null

function set(partial: Partial<Snapshot>): void {
  snap = { ...snap, ...partial }
  listeners.forEach((l) => l())
}

export function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getSnapshot(): Snapshot {
  return snap
}

// geometry bus for MapCanvas (kept outside React snapshot for canvas perf)
export interface Geometry {
  lat: Float64Array; lng: Float64Array
  adjOff: Uint32Array; adjDst: Uint32Array; adjCls: Uint8Array
  bbox: [number, number, number, number]
  villages: { node: number; name: string; pop: number }[]
  facilities: { id: number; node: number; name: string; tier: string }[]
}
let geometry: Geometry | null = null
export function getGeometry(): Geometry | null { return geometry }

export function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../worker/caregrid.worker.ts', import.meta.url), { type: 'module' })
  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed') ?? 42)
  const scenarioParam = params.get('scenario')?.toLowerCase() ?? null
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data
    switch (m.type) {
      case 'READY':
        set({ ready: true, worldStats: m.worldStats, facilities: m.facilities.map((f) => ({ id: f.id, name: f.name, tier: f.tier, bedsFree: f.bedsFree, bedsTotal: f.bedsTotal, medStock: f.meds.reduce((a, x) => a + x.qty, 0) })) })
        // D23: ?scenario=mock|mci|disaster auto-runs the matching director script
        if (scenarioParam) {
          const script = scenarioParam === 'mock' ? 'MOCK' : scenarioParam === 'mci' ? 'MCI' : scenarioParam === 'disaster' || scenarioParam === 'monsoon' ? 'DISASTER' : null
          if (script) actions.director(script as 'MOCK' | 'MCI' | 'DISASTER')
        }
        break
      case 'GEOMETRY': {
        geometry = { lat: m.lat, lng: m.lng, adjOff: m.adjOff, adjDst: m.adjDst, adjCls: m.adjCls, bbox: m.bbox, villages: m.villages, facilities: m.facilities }
        listeners.forEach((l) => l()) // nudge canvas subscribers
        break
      }
      case 'STATE': {
        const lastEv = m.events[m.events.length - 1]
        // D10: merge live facDeltas into facilities so beds/meds meters actually move
        const byId = new Map(m.facDeltas.map((fd) => [fd.id, fd]))
        const facilities = snap.facilities.map((f) => {
          const fd = byId.get(f.id)
          return fd ? { ...f, bedsFree: fd.bedsFree, bedsTotal: fd.bedsTotal, medStock: fd.medStock } : f
        })
        set({
          clockS: m.clockS, running: m.running, speedMult: m.speedMult, manual: m.manual,
          ambs: m.ambs, emgs: m.emgs, emgsTotal: m.emgsTotal, facilities, facDeltas: m.facDeltas,
          events: m.events, traces: m.traces, kpis: m.kpis, completed: m.completed, closedEdges: m.closedEdges,
          ariaAnnounce: lastEv && lastEv.kind === 'DISPATCH' ? lastEv.text : snap.ariaAnnounce,
        })
        break
      }
      case 'RECOMMENDATION': set({ recommendation: m.trace }); break
      case 'BENCH_RESULT': set({ bench: m.result }); break
      case 'WAVEFRONT': wavefrontCb?.(m.settled, m.frontier); break
      default: break
    }
  }
  worker.postMessage({ type: 'INIT', world: 'procedural', seed, preset: 'FULL' })
  return worker
}

// ---- command helpers ----
const send = (msg: Parameters<Worker['postMessage']>[0]): void => { worker?.postMessage(msg) }

export const actions = {
  start: (): void => send({ type: 'START' }),
  pause: (): void => send({ type: 'PAUSE' }),
  speed: (mult: 1 | 60 | 90): void => send({ type: 'SPEED', mult }),
  director: (script: 'MOCK' | 'MCI' | 'DISASTER'): void => {
    set({ scenario: script === 'MOCK' ? 'Official Mock' : script === 'MCI' ? 'Mass Casualty (MCI)' : 'Monsoon Disaster' })
    send({ type: 'DIRECTOR', script })
  },
  chaos: (action: string): void => send({ type: 'CHAOS', action }),
  mode: (manual: boolean): void => send({ type: 'MODE', manual }),
  batchOptimal: (on: boolean): void => { set({ batchOptimalOn: on }); send({ type: 'BATCH_OPTIMAL', on }) },
  ambient: (on: boolean): void => { set({ ambientOn: on }); send({ type: 'AMBIENT', on }) },
  setLang: (l: 'en' | 'hi'): void => { setLang(l); set({ lang: l }) }, // D19: re-render + <html lang>
  wavefront: (on: boolean): void => { set({ wavefrontOn: on }); send({ type: 'WAVEFRONT_MODE', on }) },
  recommend: (emgId: number): void => send({ type: 'RECOMMEND', emgId }),
  confirm: (emgId: number): void => send({ type: 'CONFIRM', emgId }),
  bench: (runs: 200): void => send({ type: 'BENCH', runs }),
}

// wavefront sample bus for MapCanvas
let wavefrontCb: ((settled: Uint32Array, frontier: Uint32Array) => void) | null = null
export function onWavefront(cb: ((s: Uint32Array, f: Uint32Array) => void) | null): void {
  wavefrontCb = cb
}
