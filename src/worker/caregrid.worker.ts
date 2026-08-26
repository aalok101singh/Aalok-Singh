// Worker entry: owns the engine; main thread never touches engine internals (D3/D4).
import { MinHeap } from '../engine/heap'
import { CONST } from '../engine/const'
import { components, buildWorld } from '../engine/graph'
import { proceduralWorld } from '../engine/world'
import { dijkstra, bidirectional, astar } from '../engine/pathfind'
import type { GraphView, PathResult } from '../engine/pathfind'
import { percentile, runDueTasks } from '../engine/sim'
import { mulberry32 } from '../engine/rng'
import type { Urgency } from '../engine/types'
import type { World } from '../engine/types'
import type { AmbDelta, BenchResult, BenchRow, EmgView, FromWorker, KpiView, ToWorker } from './protocol'

let gv: GraphView | null = null
let seed = 42
let presetUsed: 'FULL' | 'MED' | 'DEMO' = 'FULL'
let running = false
let speedMult: 1 | 60 | 90 = 1
let manualMode = false
let clockS = 0
let pumpTimer: ReturnType<typeof setInterval> | null = null
let nameByNode = new Map<number, string>()

// sim state owned here via dynamic import of SimEngine is unnecessary — import directly
import { SimEngine } from '../engine/sim'
let sim: SimEngine | null = null

function post(msg: FromWorker): void {
  ;(self as unknown as Worker).postMessage(msg)
}

async function init(src: 'osm' | 'procedural', sd: number, preset: 'FULL' | 'MED' | 'DEMO'): Promise<void> {
  const t0 = performance.now()
  seed = sd
  let w: World | null = null
  if (src === 'osm') {
    try {
      const res = await fetch('/district.json')
      if (res.ok) w = buildWorld(await res.json())
    } catch { /* procedural fallback */ }
  }
  if (!w) w = proceduralWorld(seed, preset)
  presetUsed = preset
  nameByNode = new Map(w.villages.map((v) => [v.node, v.name]))
  const cc = components(w)
  sim = new SimEngine(w, seed)
  gv = sim.g
  sim.onEvent = () => { /* events are pulled in STATE diffs */ }
  // §10.3 wavefront streaming: throttle samples to ≤4k settled + 1k frontier, ≤10 msgs/sec
  let lastWf = 0
  sim.onWavefront = (settled, frontier) => {
    const now = performance.now()
    if (now - lastWf < 100) return
    lastWf = now
    post({
      type: 'WAVEFRONT',
      settled: Uint32Array.from(settled.slice(0, 4096)),
      frontier: Uint32Array.from(frontier.slice(0, 1024)),
    })
  }
  post({
    type: 'READY',
    worldStats: {
      source: w.source, nodeCount: w.nodeCount, edgeCount: w.adjDst.length,
      villages: w.villages.length, facilities: w.facilities.length,
      ambulances: w.ambulances.length, components: cc.count, loadMs: performance.now() - t0,
    },
    facilities: w.facilities,
    villages: w.villages,
  })
  // geometry for the map canvas (main thread never mutates engine state)
  post({
    type: 'GEOMETRY',
    lat: w.lat.slice(), lng: w.lng.slice(),
    adjOff: w.adjOff.slice(), adjDst: w.adjDst.slice(), adjCls: w.adjCls.slice(),
    bbox: w.bbox,
    villages: w.villages, facilities: w.facilities.map((f) => ({ id: f.id, node: f.node, name: f.name, tier: f.tier })),
  })
}

let accMs = 0
function tickOnce(): void {
  if (!sim || !running) return
  // 100ms pump; sim advances speedMult sim-seconds per wall-second in TICK_S steps,
  // catch-up capped at 30s for tab throttling (§8)
  const PUMP_MS = 100
  accMs += PUMP_MS * Math.min(speedMult, 90)
  let guard = 120
  while (accMs >= CONST.TICK_S * 1000 && guard-- > 0) {
    accMs -= CONST.TICK_S * 1000
    sim.tick()
    runDueTasks(sim)
  }
  if (accMs > CONST.CATCHUP_CAP_S * 1000) accMs = CONST.CATCHUP_CAP_S * 1000
  clockS = sim.clockS
  postState()
}

function startPump(): void {
  if (pumpTimer !== null) return
  pumpTimer = setInterval(tickOnce, 100) // 10Hz pump → STATE @10Hz (§6.1 STATE_HZ)
}

function villageName(node: number): string {
  return nameByNode.get(node) ?? String(node) // O(1) — D27
}

function tierMap(f: (u: string) => number): Record<string, number> {
  return { ECHO: f('ECHO'), DELTA: f('DELTA'), CHARLIE: f('CHARLIE'), BRAVO: f('BRAVO'), ALPHA: f('ALPHA') }
}

function postState(): void {
  if (!sim) return
  const s = sim
  const ambs: AmbDelta[] = s.world.ambulances.map((a) => {
    let from = a.at, to = a.at, t01 = 0
    let route: number[] = []
    let mission = -1
    const mr = [...s.missions.values()].find((m) => m.m.amb === a.id)
    if (mr) mission = mr.m.id
    if (mr && (mr.leg === 'TO_SCENE' || mr.leg === 'TO_FACILITY')) {
      const p = s.positionOnPath(mr)
      from = p.from; to = p.to; t01 = p.t01
      route = s.remainingPath(mr).slice(0, 400)
    }
    return { id: a.id, callsign: a.callsign, cls: a.cls, state: a.state, from, to, t01, mission, route }
  })
  const emgs: EmgView[] = []
  for (const e of s.emergencies.values()) {
    if (e.status === 'DELIVERED' || e.status === 'UNREACHABLE') continue
    emgs.push({
      id: e.id, villageName: villageName(e.village), villageNode: e.village,
      urgency: e.urgency, need: e.need, caller: e.caller,
      filedAtS: e.filedAt, status: e.status, slaS: CONST.SLA_S[e.urgency],
      missionId: e.missionId, bestEffort: e.slaImpossible,
    })
  }
  // D28: cap the transported list — triage order, top-200 + aggregate count
  const rank = CONST.SEVERITY_RANK as Record<string, number>
  emgs.sort((a, b) => (rank[a.urgency] - rank[b.urgency]) || (a.filedAtS - b.filedAtS))
  const emgsTotal = emgs.length
  const emgsCapped = emgs.slice(0, 200)
  const kpis: KpiView = {
    p50ByTier: tierMap((u) => Math.round(percentile(s.kpis.responseByTier[u as Urgency], 50))),
    p90ByTier: tierMap((u) => Math.round(percentile(s.kpis.responseByTier[u as Urgency], 90))),
    slaPct: tierMap((u) => {
      const done = s.kpis.completedByTier[u as Urgency]
      return done === 0 ? 100 : Math.round((s.kpis.slaOkByTier[u as Urgency] / done) * 100)
    }),
    missionsCompleted: s.kpis.missionsCompleted,
    utilization: Math.round((s.kpis.busyUnitS / Math.max(1, s.kpis.elapsedUnitS)) * 100),
    costMean: {
      responseS: Math.round(s.kpis.costSum.responseS / Math.max(1, s.kpis.missionsCompleted)),
      onSceneS: Math.round(s.kpis.costSum.onSceneS / Math.max(1, s.kpis.missionsCompleted)),
      transportS: Math.round(s.kpis.costSum.transportS / Math.max(1, s.kpis.missionsCompleted)),
      waitS: Math.round(s.kpis.costSum.waitS / Math.max(1, s.kpis.missionsCompleted)),
    },
    costSum: { ...s.kpis.costSum },
    facLoad: s.world.facilities.map((f) => ({
      id: f.id, name: f.name,
      loadPct: f.bedsTotal === 0 ? 0 : Math.round(((f.bedsTotal - f.bedsFree) / f.bedsTotal) * 100),
    })),
  }
  post({
    type: 'STATE', tick: clockS, clockS: s.clockS,
    ambs,
    facDeltas: s.world.facilities.map((f) => ({
      id: f.id, bedsFree: f.bedsFree, bedsTotal: f.bedsTotal,
      medStock: f.meds.reduce((acc, m) => acc + m.qty, 0),
    })),
    events: s.events.slice(-40).map((ev) => ({ id: ev.id, tS: ev.tS, kind: ev.kind, text: ev.text, emgId: ev.emgId })),
    traces: s.traces.slice(-20),
    kpis,
    completed: s.completed.slice(-8).reverse(),
    closedEdges: [...s.closedEdges].slice(0, 500),
    running, speedMult, manual: manualMode,
    emgs: emgsCapped,
    emgsTotal,
  })
}

self.onmessage = async (ev: MessageEvent<ToWorker>): Promise<void> => {
  const msg = ev.data
  switch (msg.type) {
    case 'INIT': await init(msg.world, msg.seed, msg.preset); break
    case 'START': running = true; startPump(); postState(); break
    case 'PAUSE': running = false; postState(); break // D2: echo state so the button flips to Resume
    case 'SPEED': speedMult = msg.mult; postState(); break
    case 'DIRECTOR':
      if (!sim) break
      running = true // director scripts auto-start the clock (demo path: click → sim runs)
      startPump()
      if (msg.script === 'MOCK') sim.runMockScript()
      else if (msg.script === 'MCI') sim.runMciScript()
      else sim.runDisasterScript()
      postState()
      break
    case 'CHAOS':
      if (!sim) break
      if (msg.action === 'RESET_SCENARIO') {
        // D8: a reset must restore the pristine world — rebuild the whole SimEngine from the seed
        sim = new SimEngine(proceduralWorld(seed, presetUsed), seed)
        gv = sim.g
        running = false
        if (pumpTimer !== null) { clearInterval(pumpTimer); pumpTimer = null }
        clockS = 0
      } else {
        sim.chaos(msg.action)
      }
      postState()
      break
    case 'MODE':
      manualMode = msg.manual
      if (sim) sim.manual = msg.manual
      postState()
      break
    case 'BATCH_OPTIMAL':
      if (sim) sim.batchOptimal = msg.on
      postState()
      break
    case 'AMBIENT':
      if (sim) sim.ambientArrivals = msg.on
      postState()
      break
    case 'WAVEFRONT_MODE':
      if (sim) sim.wavefront = msg.on // engine streams frontier samples on pathfind (§10.3, wired in B4)
      postState()
      break
    case 'RECOMMEND':
      post({ type: 'RECOMMENDATION', trace: sim?.recommend(msg.emgId) ?? null })
      break
    case 'CONFIRM':
      sim?.confirmDispatch(msg.emgId)
      break
    case 'BENCH': benchSuite(msg.runs); break
  }
}

// ---- benchmark suite (§15): chunked so the worker stays responsive ----
function benchSuite(runs: number): void {
  if (!gv || !sim) return
  const g = gv
  const rng = mulberry32(seed + 999)
  const pairs: [number, number][] = []
  for (let i = 0; i < runs; i++) pairs.push([(rng() * g.nodeCount) | 0, (rng() * g.nodeCount) | 0])

  const measure = (name: string, fn: (s: number, t: number) => PathResult): BenchRow => {
    const times: number[] = []
    let exp = 0, rel = 0, ops = 0
    for (const [s, t] of pairs) {
      const r = fn(s, t)
      times.push(r.stats.ms); exp += r.stats.expanded; rel += r.stats.relaxed; ops += r.stats.heapOps
    }
    times.sort((a, b) => a - b)
    return {
      algorithm: name,
      meanMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3),
      p95Ms: +(times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] ?? times[times.length - 1]).toFixed(3),
      meanExpanded: Math.round(exp / times.length),
      meanRelaxed: Math.round(rel / times.length),
      heapOps: Math.round(ops / times.length),
    }
  }

  const rows: BenchRow[] = []
  const step = (i: number): void => {
    if (i === 0) rows.push(measure('Dijkstra', (s, t) => dijkstra(g, s, t)))
    else if (i === 1) rows.push(measure('Bidirectional Dijkstra', (s, t) => bidirectional(g, s, t)))
    else rows.push(measure('A*', (s, t) => astar(g, s, t)))
    if (i < 2) setTimeout(() => step(i + 1), 0)
    else finish()
  }
  const finish = (): void => {
    const cc = components(sim!.world)
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
    const result: BenchResult = {
      rows,
      graph: {
        nodes: g.nodeCount, edges: g.adjDst.length, components: cc.count,
        ramMB: mem ? +(mem / 1048576).toFixed(1) : null,
        heapOpsPerSec: heapMicro(),
      },
    }
    post({ type: 'BENCH_RESULT', result })
  }
  step(0)
}

function heapMicro(): number {
  const h = new MinHeap(1024)
  const rng = mulberry32(seed + 777)
  const t0 = performance.now()
  let acc = 0
  for (let i = 0; i < 1_000_000; i++) { const k = (rng() * 1e6) | 0; h.push(k, k & 1023); acc = (acc + (h.pop()![0] as number)) | 0 }
  const dt = (performance.now() - t0) / 1000
  if (acc === -137) console.log('unreachable') // defeat dead-code elimination (D16)
  return Math.round(1_000_000 / Math.max(dt, 0.001))
}
