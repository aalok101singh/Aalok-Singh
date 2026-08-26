// Dispatch pipeline §6.3: triage -> feasibility -> routing -> wait -> select -> assign -> trace.
import { CONST } from './const'
import { astar } from './pathfind'
import type { GraphView } from './pathfind'
import { facilityEligible } from './resources'
import type { DecisionTrace, Emergency, Facility, FacilityEval, Specialty } from './types'

export interface DispatchCtx {
  g: GraphView
  facilities: Facility[]
  closedEdges: Set<number>
  nodeMult?: Float32Array
  clockS: number
  /** §10.3 wavefront streaming: called with settled/frontier samples during pathfinding. */
  onPathfind?: (settled: number[], frontier: number[]) => void
}

export interface AmbView {
  id: number
  at: number // current node
  available: boolean
}

export interface MissionPhaseRef {
  facilityId: number
  phase: 'TO_FACILITY' | 'HANDOVER' | 'OTHER'
}

/** Wait model (§6.2.6): ceil(activeInbound / max(1, bedsFree)) * HANDOVER_SERVICE_S. */
export function waitSeconds(facility: Facility, activeInbound: number): number {
  return Math.ceil(activeInbound / Math.max(1, facility.bedsFree)) * CONST.HANDOVER_SERVICE_S
}

export function inboundCount(facilityId: number, missions: MissionPhaseRef[]): number {
  let n = 0
  for (const m of missions) if (m.facilityId === facilityId && m.phase !== 'OTHER') n++
  return n
}

/** Triage order (§6.2.8): (severity, filedAt, travelEstimate) — deterministic. */
export function triageCompare(a: Emergency, b: Emergency, travelEst: (e: Emergency) => number): number {
  const ra = CONST.SEVERITY_RANK[a.urgency], rb = CONST.SEVERITY_RANK[b.urgency]
  if (ra !== rb) return ra - rb
  if (a.filedAt !== b.filedAt) return a.filedAt - b.filedAt
  return travelEst(a) - travelEst(b)
}

interface Pairing {
  ambId: number
  ambTravelS: number
  facEval: FacilityEval
}

/**
 * Pipeline steps 2–5 for one emergency: feasibility filter, A* routes per eligible facility,
 * wait estimate, argmin total = response + ON_SCENE + transport + wait.
 * Returns evals for ALL facilities (reject reasons included) plus best ambulance+facility pairing.
 */
export function evaluate(
  ctx: DispatchCtx,
  villageNode: number,
  need: Specialty,
  ambs: AmbView[],
  missionRefs: MissionPhaseRef[],
): { evals: FacilityEval[]; pairings: Map<number, Pairing>; best: Pairing | null } {
  const evals: FacilityEval[] = ctx.facilities.map((f) => {
    const elig = facilityEligible(f, need, ctx.clockS)
    const ev: FacilityEval = { facilityId: f.id, eligible: elig.ok, travelS: 0, waitS: 0, totalS: Infinity }
    if (!elig.ok) ev.reject = elig.reject
    return ev
  })

  const pairings = new Map<number, Pairing>()
  let best: Pairing | null = null

  for (const amb of ambs) {
    if (!amb.available) continue
    const resp = astar(ctx.g, amb.at, villageNode, pathOpts(ctx))
    if (!resp.found) continue
    const responseS = Math.round(resp.dist)
    // ≤6 nearest facilities by haversine prefilter (§6.3 step 3)
    const nearest = [...ctx.facilities].sort((a, b) => havM(ctx, villageNode, a.node) - havM(ctx, villageNode, b.node)).slice(0, 6)
    for (const f of nearest) {
      const ev = evals[f.id]
      if (!ev.eligible) continue
      const tr = astar(ctx.g, villageNode, f.node, pathOpts(ctx))
      if (!tr.found) {
        if (ev.reject === undefined) { ev.reject = 'UNREACHABLE'; ev.eligible = false }
        continue
      }
      ev.travelS = Math.round(tr.dist)
      ev.waitS = waitSeconds(f, inboundCount(f.id, missionRefs))
      ev.totalS = responseS + CONST.ON_SCENE_S + ev.travelS + ev.waitS
      const pairing: Pairing = { ambId: amb.id, ambTravelS: responseS, facEval: ev }
      pairings.set(pairKey(amb.id, f.id), pairing)
      if (!best || ev.totalS < best.facEval.totalS) best = pairing
    }
  }
  return { evals, pairings, best }
}

function pathOpts(ctx: DispatchCtx) {
  return { closed: ctx.closedEdges, nodeMult: ctx.nodeMult, onProgress: ctx.onPathfind }
}

function pairKey(ambId: number, facId: number): number {
  return ambId * 100000 + facId
}

export function havM(ctx: DispatchCtx, a: number, b: number): number {
  const R = 6371000, rad = Math.PI / 180
  const dLa = (ctx.g.lat[b] - ctx.g.lat[a]) * rad
  const dLo = (ctx.g.lng[b] - ctx.g.lng[a]) * rad
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(ctx.g.lat[a] * rad) * Math.cos(ctx.g.lat[b] * rad) * Math.sin(dLo / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/**
 * Batch-optimal assignment (§6.2.7): ≤5 emergencies, enumerate patient→ambulance permutations,
 * minimize summed totals; greedy comparator retained for the Δ display.
 */
export function batchAssign(
  ctx: DispatchCtx,
  emgs: Emergency[],
  ambs: AmbView[],
  missionRefs: MissionPhaseRef[],
): { assignments: Map<number, Pairing>; evalsByEmg: Map<number, FacilityEval[]>; optimalTotal: number; greedyTotal: number } {
  const evalsByEmg = new Map<number, FacilityEval[]>()
  const perEmg: { emg: Emergency; options: { pairing: Pairing; key: number }[] }[] = []
  for (const emg of emgs.slice(0, CONST.BATCH_MAX)) {
    const { evals, pairings, best } = evaluate(ctx, emg.village, emg.need, ambs, missionRefs)
    evalsByEmg.set(emg.id, evals)
    const options = [...pairings.entries()].map(([key, pairing]) => ({ pairing, key }))
    perEmg.push({ emg, options })
    void best
  }

  // greedy: each patient independently takes its own cheapest option
  const usedGreedy = new Set<number>()
  let greedyTotal = 0
  for (const p of perEmg) {
    const free = p.options.filter((o) => !usedGreedy.has(o.pairing.ambId)).sort((a, b) => a.pairing.facEval.totalS - b.pairing.facEval.totalS)[0]
    if (free) { usedGreedy.add(free.pairing.ambId); greedyTotal += free.pairing.facEval.totalS }
  }

  // optimal: permute ambulance choices when the joint count is tractable (≤ BATCH_MAX! = 120)
  const assignments = new Map<number, Pairing>()
  let optimalTotal = Infinity
  if (perEmg.length >= 2 && perEmg.every((p) => p.options.length > 0)) {
    const chosenPerEmg: (Pairing | null)[] = new Array(perEmg.length).fill(null)
    const usedAmb = new Set<number>()
    let acc = 0
    const recurse = (idx: number): void => {
      if (acc >= optimalTotal) return // bound
      if (idx === perEmg.length) {
        if (acc < optimalTotal) {
          optimalTotal = acc
          for (let i = 0; i < perEmg.length; i++) assignments.set(perEmg[i].emg.id, chosenPerEmg[i]!)
        }
        return
      }
      for (const o of perEmg[idx].options.sort((a, b) => a.pairing.facEval.totalS - b.pairing.facEval.totalS)) {
        if (usedAmb.has(o.pairing.ambId)) continue
        usedAmb.add(o.pairing.ambId)
        chosenPerEmg[idx] = o.pairing
        acc += o.pairing.facEval.totalS
        recurse(idx + 1)
        acc -= o.pairing.facEval.totalS
        chosenPerEmg[idx] = null
        usedAmb.delete(o.pairing.ambId)
      }
    }
    recurse(0)
  } else if (perEmg.length === 1 && perEmg[0].options.length > 0) {
    const solo = perEmg[0].options.reduce((m, o) => (o.pairing.facEval.totalS < m.pairing.facEval.totalS ? o : m)).pairing
    assignments.set(perEmg[0].emg.id, solo)
    optimalTotal = solo.facEval.totalS
  }
  if (!isFinite(optimalTotal)) optimalTotal = greedyTotal

  return { assignments, evalsByEmg, optimalTotal, greedyTotal }
}

/** Steps 7: human-readable DecisionTrace. */
export function buildTrace(
  emg: { id: number; urgency: Emergency['urgency'] },
  evals: FacilityEval[],
  chosen: Pairing,
  callsignOf: (ambId: number) => string,
  batchDelta?: number,
): DecisionTrace {
  const eligibleN = evals.filter((e) => e.eligible).length
  const c = chosen.facEval
  const summary =
    `${fmt(c.totalS)} = ${fmt(chosen.ambTravelS)} + ${fmt(CONST.ON_SCENE_S)} + ${fmt(c.travelS)} + ${fmt(c.waitS)}` +
    (batchDelta !== undefined ? ` · Δ vs greedy ${fmt(batchDelta)}` : '') +
    ` · ${eligibleN}/${evals.length} eligible`
  return {
    emgId: emg.id,
    evals,
    chosenId: c.facilityId,
    ambCallsign: callsignOf(chosen.ambId),
    ambTravelS: chosen.ambTravelS,
    summary,
  }
}

function fmt(s: number): string {
  if (!isFinite(s)) return '∞'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
