// Typed worker message contracts (§9).
import type { DecisionTrace, Facility, Mission } from '../engine/types'

export type ChaosAction =
  | 'INJECT_ECHO' | 'INJECT_DELTA' | 'INJECT_CHARLIE' | 'MASS_INFLUX_8' | 'STRESS_SURGE_1000'
  | 'CLOSE_RANDOM_ROAD' | 'SEVER_ACTIVE_MISSION_ROAD' | 'REOPEN_ALL' | 'WEATHER_SPIKE'
  | 'DRAIN_BEDS_CHC' | 'DEPLETE_MEDS_PHC' | 'FORCE_SPECIALIST_OFFSHIFT'
  | 'DUPLICATE_STORM' | 'RESET_SCENARIO'

export interface WorldStats {
  source: 'osm' | 'procedural'
  nodeCount: number
  edgeCount: number
  villages: number
  facilities: number
  ambulances: number
  components: number
  loadMs: number
}

export interface AmbDelta {
  id: number; callsign: string; cls: string; state: string;
  from: number; to: number; t01: number
}

export interface EmgView {
  id: number; villageName: string; villageNode: number;
  urgency: string; need: string; caller: string;
  filedAtS: number; status: string; slaS: number;
  missionId: number; bestEffort: boolean
}

export interface FacDelta {
  id: number; bedsFree: number; bedsTotal: number
}

export interface KpiView {
  p50ByTier: Record<string, number>
  p90ByTier: Record<string, number>
  slaPct: Record<string, number>
  missionsCompleted: number
  utilization: number
  costMean: { responseS: number; onSceneS: number; transportS: number; waitS: number }
  facLoad: { id: number; name: string; loadPct: number }[]
}

export interface BenchRow {
  algorithm: string
  meanMs: number; p95Ms: number
  meanExpanded: number; meanRelaxed: number; heapOps: number
}

export interface BenchResult {
  rows: BenchRow[]
  graph: { nodes: number; edges: number; components: number; ramMB: number | null; heapOpsPerSec: number }
}

// Main -> Worker
export type ToWorker =
  | { type: 'INIT'; world: 'osm' | 'procedural'; seed: number; preset: 'FULL' | 'MED' | 'DEMO' }
  | { type: 'START' } | { type: 'PAUSE' }
  | { type: 'SPEED', mult: 1 | 2 | 5 }
  | { type: 'DIRECTOR', script: 'MOCK' | 'MCI' | 'DISASTER' }
  | { type: 'CHAOS', action: ChaosAction }
  | { type: 'MODE', manual: boolean }
  | { type: 'WAVEFRONT_MODE', on: boolean }
  | { type: 'RECOMMEND', emgId: number }
  | { type: 'CONFIRM', emgId: number }
  | { type: 'BENCH', runs: 200 }

// Worker -> Main
export interface StateMsg {
  type: 'STATE'
  tick: number
  clockS: number
  ambs: AmbDelta[]
  emgs: EmgView[]
  facDeltas: FacDelta[]
  events: { id: number; tS: number; kind: string; text: string; emgId?: number }[]
  traces: DecisionTrace[]
  kpis: KpiView
  closedEdges: number[]
  running: boolean
  speedMult: number
  manual: boolean
}
export type FromWorker =
  | { type: 'READY'; worldStats: WorldStats; facilities: Facility[]; villages: { node: number; name: string; pop: number }[] }
  | {
    type: 'GEOMETRY'
    lat: Float64Array; lng: Float64Array
    adjOff: Uint32Array; adjDst: Uint32Array; adjCls: Uint8Array
    bbox: [number, number, number, number]
    villages: { node: number; name: string; pop: number }[]
    facilities: { id: number; node: number; name: string; tier: string }[]
  }
  | StateMsg
  | { type: 'RECOMMENDATION'; trace: DecisionTrace | null }
  | { type: 'WAVEFRONT'; settled: Uint32Array; frontier: Uint32Array }
  | { type: 'REPORT'; mission: Mission; emgUrgency: string }
  | { type: 'BENCH_RESULT'; result: BenchResult }
