// Sim: fixed 1s tick, event queue, mission lifecycle, KPIs, director scripts, chaos (§8, §13).
import { CONST } from './const'
import { astar } from './pathfind'
import type { GraphView } from './pathfind'
import { batchAssign, buildTrace, evaluate } from './dispatch'
import type { AmbView, MissionPhaseRef } from './dispatch'
import { dispenseFEFO, restockFacility } from './resources'
import { expSeconds, mulberry32 } from './rng'
import type { Rng } from './rng'
import type { Ambulance, DecisionTrace, Emergency, Mission, Specialty, Urgency, World } from './types'

export interface SimEvent {
  id: number
  tS: number
  kind: 'DISPATCH' | 'SCENE' | 'TRANSPORT' | 'DELIVERED' | 'ALERT' | 'REROUTE' | 'ESCALATED' | 'DEDUPED' | 'SLA' | 'PARTIAL' | 'UNREACHABLE' | 'WEATHER' | 'CLOSURE'
  text: string
  trace?: DecisionTrace
  emgId?: number
}

export interface RuntimeEmergency extends Emergency {
  slaImpossible: boolean
  escalateAtS: number
}

export interface MissionRuntime {
  m: Mission
  leg: 'TO_SCENE' | 'ON_SCENE' | 'TO_FACILITY' | 'HANDOVER'
  path: number[] // node ids of current animated leg
  cumW: number[] // cumulative seconds along path
  legStartS: number
  legDurS: number
  waitRealizedS: number
  medDoses: number
}

export interface Kpis {
  responseByTier: Record<Urgency, number[]>
  completedByTier: Record<Urgency, number>
  slaOkByTier: Record<Urgency, number>
  missionsCompleted: number
  busyUnitS: number
  elapsedUnitS: number
  costSum: { responseS: number; onSceneS: number; transportS: number; waitS: number }
}

const URG_DIST: [Urgency, number][] = [['ECHO', 5], ['DELTA', 15], ['CHARLIE', 25], ['BRAVO', 30], ['ALPHA', 25]]
const SPEC_WEIGHTS: [Specialty, number][] = [
  ['GENERAL', 34], ['CARDIOLOGY', 16], ['OBSTETRIC', 18], ['PEDIATRIC', 14], ['SURGERY', 10], ['TRAUMA', 8],
]
const CALLERS: [Emergency['caller'], number][] = [['FAMILY', 55], ['ASHA', 30], ['PHC_REFERRAL', 15]]

export class SimEngine {
  readonly g: GraphView
  clockS = 0
  running = false
  speedMult: 1 | 2 | 5 = 1
  manual = false
  wavefront = false
  batchOptimal = true
  ambientArrivals = true
  influxUntilS = -1

  private rng: Rng
  private nextArrivalS = 60
  private emgSeq = 1
  private missionSeq = 1
  private eventSeq = 1
  private restockAtS = CONST.RESTOCK_PERIOD_S
  private bedReleaseAt: { facId: number; atS: number }[] = []
  private dedupe = new Map<string, number>()

  emergencies = new Map<number, RuntimeEmergency>()
  missions = new Map<number, MissionRuntime>()
  closedEdges = new Set<number>()
  events: SimEvent[] = []
  traces: DecisionTrace[] = []
  lastTraces: DecisionTrace[] = []
  kpis: Kpis
  directorArmed: ((s: SimEngine) => void) | null = null
  onWavefront: ((settled: number[], frontier: number[]) => void) | null = null
  weatherForceMm: number | null = null
  onEvent: ((e: SimEvent) => void) | null = null
  degradedBannerShown = false

  constructor(public world: World, public seed: number) {
    this.g = {
      nodeCount: world.nodeCount,
      lat: world.lat, lng: world.lng,
      adjOff: world.adjOff, adjDst: world.adjDst, adjW: world.adjW,
    }
    this.rng = mulberry32(seed)
    this.kpis = emptyKpis()
  }

  // ---- lifecycle ----
  reset(): void {
    this.clockS = 0
    this.rng = mulberry32(this.seed)
    this.emergencies.clear()
    this.missions.clear()
    this.closedEdges.clear()
    this.events = []
    this.traces = []
    this.kpis = emptyKpis()
    this.nextArrivalS = 60 + expSeconds(this.rng, CONST.ARRIVALS_MEAN_S)
    this.restockAtS = CONST.RESTOCK_PERIOD_S
    this.bedReleaseAt = []
    this.dedupe.clear()
    for (const a of this.world.ambulances) { a.state = 'AVAILABLE'; a.missionId = -1; a.edgeProgress = 0 }
    for (const f of this.world.facilities) f.bedsFree = f.bedsTotal
    if (this.directorArmed) { const d = this.directorArmed; this.directorArmed = null; d(this) }
  }

  tick(): void {
    this.clockS += CONST.TICK_S
    const t = this.clockS

    // arrivals (Poisson §8) — ambient background; disable to test single injections
    if (this.ambientArrivals && t >= this.nextArrivalS && this.emergencesUnderCap()) {
      this.spawnRandomEmergency()
      const mean = t < this.influxUntilS ? CONST.ARRIVALS_MEAN_S / CONST.INFLUX_MULT : CONST.ARRIVALS_MEAN_S
      this.nextArrivalS = t + Math.max(5, expSeconds(this.rng, mean))
    }

    // queued / awaiting-confirm processing
    const queued: RuntimeEmergency[] = []
    for (const e of this.emergencies.values()) {
      if (e.status === 'QUEUED') queued.push(e)
      else if (e.status === 'AWAITING_CONFIRM') {
        if (t >= e.escalateAtS) {
          e.status = 'QUEUED'
          this.dispatchBatch([e])
          this.push('ESCALATED', `${nameOf(this.world, e.village)} auto-escalated (${pct(CONST.CONFIRM_ESCALATE)} of SLA elapsed)`, e.id)
        }
      }
      // SLA breach watch for in-flight missions
      if ((e.status === 'ASSIGNED') ) {
        const mr = [...this.missions.values()].find((mm) => mm.m.emg === e.id)
        if (mr && mr.leg === 'TO_SCENE' && t > CONST.SLA_S[e.urgency] + mr.m.tDispatch && !this.slaLogged.has(e.id)) {
          this.slaLogged.add(e.id)
          this.push('SLA', `⚠ ${urgency(e.urgency)} ${nameOf(this.world, e.village)} breached ${urgency(e.urgency)} SLA`, e.id)
        }
      }
    }
    if (queued.length > 0) this.dispatchBatch(queued.sort((a, b) => triage(a, b, this)))

    // mission progression
    for (const mr of [...this.missions.values()]) this.progressMission(mr)

    // restock + bed release
    if (t >= this.restockAtS) {
      this.restockAtS += CONST.RESTOCK_PERIOD_S
      for (const f of this.world.facilities) restockFacility(f, this.rng)
    }
    while (this.bedReleaseAt.length > 0 && this.bedReleaseAt[0].atS <= t) {
      const rel = this.bedReleaseAt.shift()!
      const f = this.world.facilities[rel.facId]
      if (f.bedsFree < f.bedsTotal) f.bedsFree++
    }

    // fleet utilization bookkeeping
    let busy = 0
    for (const a of this.world.ambulances) if (a.state !== 'AVAILABLE') busy++
    this.kpis.busyUnitS += busy * CONST.TICK_S
    this.kpis.elapsedUnitS += this.world.ambulances.length * CONST.TICK_S

    runDueTasks(this)
  }

  slaLogged = new Set<number>()

  private emergencesUnderCap(): boolean {
    return this.emergencies.size < 200 // backpressure cap (§13.2)
  }

  // ---- emergency creation ----
  spawnRandomEmergency(villageNode?: number, urgency?: Urgency, need?: Specialty, caller?: Emergency['caller']): RuntimeEmergency {
    const v = villageNode ?? this.world.villages[(this.rng() * this.world.villages.length) | 0].node
    const u = urgency ?? weightedUrgency(this.rng)
    const sp = need ?? weightedSpec(this.rng)
    const c = caller ?? weightedCaller(this.rng)
    return this.createEmergency(v, u, sp, c)
  }

  createEmergency(villageNode: number, urgency: Urgency, need: Specialty, caller: Emergency['caller']): RuntimeEmergency {
    const key = `${villageNode}:${need}`
    const last = this.dedupe.get(key)
    if (last !== undefined && this.clockS - last < CONST.DEDUPE_WINDOW_S) {
      this.dedupe.set(key, this.clockS)
      this.push('DEDUPED', `duplicate request merged: ${nameOf(this.world, villageNode)} (${urgency})`)
      const existing = [...this.emergencies.values()].reverse().find((e) => e.village === villageNode && e.need === need)
      if (existing) return existing
    }
    this.dedupe.set(key, this.clockS)

    // SLA-impossible pre-check (§6.3 warning): haversine/25kmh lower bound vs SLA
    const ambView = this.availableAmbulances()[0]
    let impossible = false
    if (ambView) {
      const d = astar(this.g, ambView.at, villageNode).dist
      impossible = !isFinite(d) || d > CONST.SLA_S[urgency] * 2.5
    }
    const emg: RuntimeEmergency = {
      id: this.emgSeq++, village: villageNode, urgency, need, caller,
      filedAt: this.clockS,
      status: this.manual && urgency !== 'ECHO' ? 'AWAITING_CONFIRM' : 'QUEUED',
      missionId: -1,
      slaImpossible: impossible,
      escalateAtS: this.clockS + CONST.SLA_S[urgency] * CONST.CONFIRM_ESCALATE,
    }
    this.emergencies.set(emg.id, emg)
    this.push(urgency === 'ECHO' ? 'ALERT' : 'DISPATCH', `incoming ${urgency} · ${nameOf(this.world, villageNode)} · needs ${need} · ${caller}${impossible ? ' · ⚠ best-effort (SLA)' : ''}`, emg.id)
    return emg
  }

  confirmDispatch(emgId: number): void {
    const e = this.emergencies.get(emgId)
    if (!e || e.status !== 'AWAITING_CONFIRM') return
    e.status = 'QUEUED'
    this.dispatchBatch([e])
  }

  recommend(emgId: number): DecisionTrace | null {
    const e = this.emergencies.get(emgId)
    if (!e) return null
    const ctx = {
      g: this.g, facilities: this.world.facilities, closedEdges: this.closedEdges, clockS: this.clockS,
      onPathfind: this.wavefront && this.onWavefront ? this.onWavefront : undefined,
    }
    const refs = this.phaseRefs()
    const ambs = this.availableAmbulances()
    const { evals, best } = evaluate(ctx, e.village, e.need, ambs, refs)
    if (!best) return null
    return buildTrace(e, evals, best, (id) => this.world.ambulances[id].callsign)
  }

  // ---- dispatch pipeline ----
  /** §6.2.9 dynamic resource re-allocation. Returns true if a unit was freed. */
  private preemptForEcho(): boolean {
    let cand: MissionRuntime | null = null
    for (const mr of this.missions.values()) {
      if (mr.leg !== 'TO_SCENE') continue // never ON_SCENE / TO_FACILITY / HANDOVER — patient aboard
      const emg = this.emergencies.get(mr.m.emg)
      if (!emg || emg.urgency === 'ECHO') continue
      if (!cand || mr.m.id > cand.m.id) cand = mr // most recently dispatched
    }
    if (!cand) return false
    const amb = this.world.ambulances[cand.m.amb]
    const oldEmg = this.emergencies.get(cand.m.emg)
    if (oldEmg) {
      // release reserved bed; med dose is dispensed on arrival only → nothing to refund
      const fac = this.world.facilities[cand.m.facility]
      fac.bedsFree = Math.min(fac.bedsTotal, fac.bedsFree + 1)
      oldEmg.status = 'QUEUED' // filedAt unchanged → triage sorts it front-of-tier
      oldEmg.missionId = -1
      this.push('ALERT', `PREEMPTED · ${nameOf(this.world, oldEmg.village)} re-queued front-of-tier (unit re-allocated to ECHO)`, oldEmg.id)
    }
    this.missions.delete(cand.m.id)
    amb.state = 'AVAILABLE'
    amb.at = this.currentNodeOf(cand) // re-allocation from current edge position
    return true
  }

  private availableAmbulances(): AmbView[] {
    return this.world.ambulances.filter((a) => a.state === 'AVAILABLE').map((a) => ({ id: a.id, at: a.at, available: true }))
  }

  private phaseRefs(): MissionPhaseRef[] {
    const refs: MissionPhaseRef[] = []
    for (const mr of this.missions.values()) {
      refs.push({
        facilityId: mr.m.facility,
        phase: mr.leg === 'TO_FACILITY' || mr.leg === 'HANDOVER' ? mr.leg : 'OTHER',
      })
    }
    return refs
  }

  dispatchOne(emg: RuntimeEmergency): void {
    this.dispatchBatch([emg])
  }

  private dispatchBatch(queued: RuntimeEmergency[]): void {
    let ambs = this.availableAmbulances()
    // §6.2.9 ECHO preemption: zero AVAILABLE + an ECHO waiting → re-allocate the newest
    // non-ECHO TO_SCENE mission (patient not aboard); preempted patient re-queues front-of-tier.
    if (ambs.length === 0 && queued.some((e) => e.urgency === 'ECHO')) {
      if (this.preemptForEcho()) ambs = this.availableAmbulances()
    }
    const ctx = {
      g: this.g, facilities: this.world.facilities, closedEdges: this.closedEdges, clockS: this.clockS,
      onPathfind: this.wavefront && this.onWavefront ? this.onWavefront : undefined,
    }
    const refs = this.phaseRefs()
    if (ambs.length === 0) {
      if (!this.degradedBannerShown) {
        this.degradedBannerShown = true
        this.push('ALERT', 'fleet exhausted — zero available units, queue holding')
      }
      return
    }
    this.degradedBannerShown = false

    if (queued.length >= 2 && queued.length <= CONST.BATCH_MAX) {
      const { assignments, evalsByEmg, optimalTotal, greedyTotal } = batchAssign(ctx, queued, ambs, refs)
      const delta = optimalTotal - greedyTotal
      this.lastTraces = []
      for (const emg of queued) {
        const chosen = assignments.get(emg.id)
        if (!chosen) continue
        const trace = buildTrace(emg, evalsByEmg.get(emg.id) ?? [], chosen, (id) => this.world.ambulances[id].callsign, delta)
        this.executeAssignment(emg, chosen.ambId, chosen.facEval.facilityId, trace)
        this.lastTraces.push(trace)
      }
      return
    }

    for (const emg of queued) {
      const { evals, best } = evaluate(ctx, emg.village, emg.need, ambs, refs)
      if (!best) {
        // all routes failed or no units — mark unreachable if no eligible route exists anywhere
        if (!evals.some((ev) => ev.eligible)) {
          emg.status = 'UNREACHABLE'
          this.push('UNREACHABLE', `${nameOf(this.world, emg.village)} UNREACHABLE — no qualified reachable facility`, emg.id)
        }
        continue
      }
      const trace = buildTrace(emg, evals, best, (id) => this.world.ambulances[id].callsign)
      this.executeAssignment(emg, best.ambId, best.facEval.facilityId, trace)
    }
  }

  private executeAssignment(emg: RuntimeEmergency, ambId: number, facId: number, trace: DecisionTrace): void {
    const amb = this.world.ambulances[ambId]
    const fac = this.world.facilities[facId]
    const resp = astar(this.g, amb.at, emg.village, { closed: this.closedEdges })
    const trans = astar(this.g, emg.village, fac.node, { closed: this.closedEdges })
    if (!resp.found || !trans.found) {
      this.push('UNREACHABLE', `${amb.callsign} could not reach scene/facility — requeue`, emg.id)
      return
    }
    const mission: Mission = {
      id: this.missionSeq++, emg: emg.id, amb: ambId, facility: facId,
      tDispatch: this.clockS, tSceneArrive: -1, tSceneLeave: -1, tFacilityArrive: -1,
      cost: { responseS: Math.round(resp.dist), onSceneS: CONST.ON_SCENE_S, transportS: Math.round(trans.dist), waitS: 0 },
      trace,
    }
    const mr: MissionRuntime = {
      m: mission, leg: 'TO_SCENE',
      path: resp.path, cumW: cumulative(this.g, resp.path),
      legStartS: this.clockS, legDurS: Math.round(resp.dist),
      waitRealizedS: 0, medDoses: 1,
    }
    this.missions.set(mission.id, mr)
    amb.state = 'TO_SCENE'
    amb.missionId = mission.id
    emg.status = 'ASSIGNED'
    emg.missionId = mission.id
    fac.bedsFree = Math.max(0, fac.bedsFree - 1) // reserve (§6.3 step 6)
    this.traces.push(trace)
    this.push('DISPATCH', `${amb.callsign} → ${fac.name} (${emg.urgency}) · ${nameOf(this.world, emg.village)} · ${trace.summary}`, emg.id, trace)
  }

  private progressMission(mr: MissionRuntime): void {
    const t = this.clockS
    const amb = this.world.ambulances[mr.m.amb]
    const emg = this.emergencies.get(mr.m.emg)
    switch (mr.leg) {
      case 'TO_SCENE': {
        if (t >= mr.legStartS + mr.legDurS) {
          mr.leg = 'ON_SCENE'; mr.legStartS = t; mr.legDurS = CONST.ON_SCENE_S
          mr.m.tSceneArrive = t
          amb.state = 'ON_SCENE'; amb.at = mr.path[mr.path.length - 1]
          if (emg) emg.status = 'ON_SCENE'
          this.push('SCENE', `${amb.callsign} on scene at ${nameOf(this.world, amb.at)}`, emg?.id)
        }
        break
      }
      case 'ON_SCENE': {
        if (t >= mr.legStartS + mr.legDurS) {
          mr.leg = 'TO_FACILITY'
          mr.m.tSceneLeave = t
          const fac = this.world.facilities[mr.m.facility]
          const tr = astar(this.g, amb.at, fac.node, { closed: this.closedEdges })
          if (!tr.found) { this.rerouteFrom(mr); return }
          mr.path = tr.path; mr.cumW = cumulative(this.g, tr.path)
          mr.legStartS = t; mr.legDurS = Math.round(tr.dist)
          mr.m.cost.transportS = mr.legDurS
          amb.state = 'TO_FACILITY'
          if (emg) emg.status = 'TRANSPORT'
          this.push('TRANSPORT', `${amb.callsign} transporting → ${fac.name} (${fmtDur(mr.legDurS)})`, emg?.id)
        }
        break
      }
      case 'TO_FACILITY': {
        if (t >= mr.legStartS + mr.legDurS) {
          mr.leg = 'HANDOVER'
          mr.m.tFacilityArrive = t
          const fac = this.world.facilities[mr.m.facility]
          amb.state = 'HANDOVER'; amb.at = fac.node
          // medicine FEFO dose on arrival (§8) — partial fulfillment logged
          const got = dispenseFEFO(fac, emg?.need ?? 'GENERAL', 1)
          if (got === 0) this.push('PARTIAL', `PARTIAL_FULFILLMENT at ${fac.name}: ${CONST.DRUG_FOR[emg?.need ?? 'GENERAL']} out of stock`, emg?.id)
          // realized handover wait (§6.2.6 with live inbound)
          const inbound = this.phaseRefs().filter((r) => r.facilityId === fac.id && r.phase === 'HANDOVER').length - 1
          mr.waitRealizedS = Math.max(CONST.HANDOVER_SERVICE_S, Math.ceil(Math.max(0, inbound) / Math.max(1, fac.bedsFree)) * CONST.HANDOVER_SERVICE_S)
          mr.legStartS = t
          mr.legDurS = mr.waitRealizedS
          mr.m.cost.waitS = mr.waitRealizedS
          this.bedReleaseAt.push({ facId: fac.id, atS: t + CONST.BED_OCCUPY_S })
          this.bedReleaseAt.sort((a, b) => a.atS - b.atS)
        }
        break
      }
      case 'HANDOVER': {
        if (t >= mr.legStartS + mr.legDurS) {
          amb.state = 'AVAILABLE'
          amb.missionId = -1
          this.completeKpis(mr)
          this.push('DELIVERED', `${amb.callsign} AVAILABLE @ ${this.world.facilities[mr.m.facility].name} · mission #${mr.m.id} complete`, emg?.id)
          this.missions.delete(mr.m.id)
        }
        break
      }
    }
  }

  /** Mid-route closure: recompute remaining leg from ambulance's current edge position (§8). */
  rerouteFrom(mr: MissionRuntime, closedEdgeIdx?: number): void {
    if (closedEdgeIdx !== undefined) this.closedEdges.add(closedEdgeIdx)
    const amb = this.world.ambulances[mr.m.amb]
    const posNode = this.currentNodeOf(mr)
    const dest = mr.leg === 'TO_SCENE' ? mr.path[mr.path.length - 1] : this.world.facilities[mr.m.facility].node
    const r = astar(this.g, posNode, dest, { closed: this.closedEdges })
    const oldDur = mr.legDurS - (this.clockS - mr.legStartS)
    if (!r.found) {
      this.push('REROUTE', `${amb.callsign}: NO ROUTE remaining — holding position`, mr.m.emg)
      return
    }
    mr.path = r.path
    mr.cumW = cumulative(this.g, r.path)
    mr.legStartS = this.clockS
    mr.legDurS = Math.round(r.dist)
    const delta = mr.legDurS - oldDur
    this.push('REROUTE', `${amb.callsign} rerouted mid-leg ${delta >= 0 ? '+' : ''}${fmtDur(delta)}`, mr.m.emg)
  }

  currentNodeOf(mr: MissionRuntime): number {
    const elapsed = this.clockS - mr.legStartS
    for (let i = 1; i < mr.cumW.length; i++) {
      if (elapsed <= mr.cumW[i]) return mr.path[i - 1]
    }
    return mr.path[mr.path.length - 1] ?? mr.path[0]
  }

  /** Fractional position between path[i-1] and path[i] for rendering. */
  positionOnPath(mr: MissionRuntime): { from: number; to: number; t01: number } {
    const elapsed = this.clockS - mr.legStartS
    for (let i = 1; i < mr.cumW.length; i++) {
      if (elapsed <= mr.cumW[i]) {
        const seg = mr.cumW[i] - mr.cumW[i - 1]
        return { from: mr.path[i - 1], to: mr.path[i], t01: seg > 0 ? (elapsed - mr.cumW[i - 1]) / seg : 1 }
      }
    }
    const last = mr.path.length - 1
    return { from: mr.path[last], to: mr.path[last], t01: 1 }
  }

  /** Remaining nodes of the current leg (current edge + rest) for full-route rendering. */
  remainingPath(mr: MissionRuntime): number[] {
    const elapsed = this.clockS - mr.legStartS
    for (let i = 1; i < mr.cumW.length; i++) {
      if (elapsed <= mr.cumW[i]) return mr.path.slice(Math.max(0, i - 1))
    }
    return mr.path.length > 0 ? [mr.path[mr.path.length - 1]] : []
  }

  private completeKpis(mr: MissionRuntime): void {
    const k = this.kpis
    const emg = this.emergencies.get(mr.m.emg)
    const tier = emg?.urgency ?? 'ALPHA'
    const resp = mr.m.tSceneArrive - mr.m.tDispatch
    k.responseByTier[tier].push(resp)
    if (k.responseByTier[tier].length > 100) k.responseByTier[tier].shift()
    k.completedByTier[tier]++
    k.missionsCompleted++
    if (resp <= CONST.SLA_S[tier]) k.slaOkByTier[tier]++
    k.costSum.responseS += mr.m.cost.responseS
    k.costSum.onSceneS += mr.m.cost.onSceneS
    k.costSum.transportS += mr.m.cost.transportS
    k.costSum.waitS += mr.m.cost.waitS
    if (emg) emg.status = 'DELIVERED'
  }

  push(kind: SimEvent['kind'], text: string, emgId?: number, trace?: DecisionTrace): void {
    const e: SimEvent = { id: this.eventSeq++, tS: this.clockS, kind, text, emgId, trace }
    this.events.push(e)
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300)
    this.onEvent?.(e)
  }

  // ---- chaos triggers (§13.2) ----
  chaos(action: string): string {
    const pickVillage = (): number => this.world.villages[(this.rng() * this.world.villages.length) | 0].node
    switch (action) {
      case 'INJECT_ECHO': this.spawnRandomEmergency(pickVillage(), 'ECHO'); return 'ECHO injected'
      case 'INJECT_DELTA': this.spawnRandomEmergency(pickVillage(), 'DELTA'); return 'DELTA injected'
      case 'INJECT_CHARLIE': this.spawnRandomEmergency(pickVillage(), 'CHARLIE'); return 'CHARLIE injected'
      case 'MASS_INFLUX_8':
        this.influxUntilS = this.clockS + 300
        for (let i = 0; i < 8; i++) this.spawnRandomEmergency()
        return 'mass influx ×8'
      case 'CLOSE_RANDOM_ROAD': {
        const idx = this.randomEdgeIndex()
        this.closedEdges.add(idx)
        this.checkActivePaths()
        this.push('CLOSURE', `road closure: edge #${idx}`)
        return 'road closed'
      }
      case 'SEVER_ACTIVE_MISSION_ROAD': {
        const active = [...this.missions.values()].filter((m) => m.leg === 'TO_SCENE' || m.leg === 'TO_FACILITY')
        if (active.length === 0) return 'no active legs'
        const mr = active[(this.rng() * active.length) | 0]
        const edgeIdx = this.edgeAheadOf(mr)
        if (edgeIdx !== undefined) {
          this.closedEdges.add(edgeIdx)
          this.rerouteFrom(mr)
          return `severed road under ${this.world.ambulances[mr.m.amb].callsign}`
        }
        return 'no forward edge found'
      }
      case 'REOPEN_ALL':
        this.closedEdges.clear()
        this.push('CLOSURE', 'all roads reopened')
        return 'reopened'
      case 'WEATHER_SPIKE':
        this.weatherForceMm = 5
        this.applyWeatherMultiplier()
        this.push('WEATHER', 'monsoon spike ×1.5 in 3 zones')
        return 'weather spiked'
      case 'DRAIN_BEDS_CHC': {
        const chcs = this.world.facilities.filter((f) => f.tier === 'CHC')
        if (!chcs.length) return 'no CHC'
        const f = chcs[(this.rng() * chcs.length) | 0]
        f.bedsFree = 0
        this.push('ALERT', `${f.name}: beds full`)
        return `${f.name} beds drained`
      }
      case 'DEPLETE_MEDS_PHC': {
        const phcs = this.world.facilities.filter((f) => f.tier === 'PHC')
        if (!phcs.length) return 'no PHC'
        const f = phcs[(this.rng() * phcs.length) | 0]
        for (const m of f.meds) m.qty = 0
        this.push('ALERT', `${f.name}: medicine stock depleted`)
        return `${f.name} meds depleted`
      }
      case 'FORCE_SPECIALIST_OFFSHIFT': {
        const f = this.world.facilities[(this.rng() * this.world.facilities.length) | 0]
        for (const d of f.doctors) d.onDutyUntil = Math.min(d.onDutyUntil, this.clockS)
        this.push('ALERT', `${f.name}: specialists off-shift`)
        return `${f.name} specialist off-shift`
      }
      case 'DUPLICATE_STORM': {
        const v = pickVillage()
        for (let i = 0; i < 3; i++) this.createEmergency(v, 'BRAVO', 'GENERAL', 'FAMILY')
        return 'duplicate storm ×3 (dedupe window)'
      }
      case 'STRESS_SURGE_1000': {
        // §13.2 #14: 1,000 emergencies over 60s — organizer "thousands of concurrent influxes" floor
        for (let i = 0; i < 1000; i++) {
          setTimeoutSim(this, Math.floor(i / 17), () => { this.spawnRandomEmergency() })
        }
        return 'stress surge ×1000 over 60s'
      }
      default: return 'unknown action'
    }
  }

  applyWeatherMultiplier(): Float32Array {
    const mult = this.weatherForceMm !== null ? 1 + (Math.min(this.weatherForceMm, 5) / 5) * 0.5 : 1
    const arr = new Float32Array(this.world.nodeCount)
    if (mult <= 1) return arr
    const zones = seededZones(this.seed)
    for (const z of zones) {
      for (let i = 0; i < this.world.nodeCount; i++) {
        if (this.world.lat[i] >= z.minLat && this.world.lat[i] <= z.maxLat && this.world.lng[i] >= z.minLng && this.world.lng[i] <= z.maxLng) arr[i] = mult
      }
    }
    return arr
  }

  nodeMultCache: Float32Array | null = null

  private randomEdgeIndex(): number {
    const total = this.world.adjDst.length
    return (this.rng() * total) | 0 // deterministic draw (§8)
  }

  private edgeAheadOf(mr: MissionRuntime): number | undefined {
    const elapsed = this.clockS - mr.legStartS
    for (let i = 1; i < mr.cumW.length; i++) {
      if (mr.cumW[i] > elapsed) {
        // find directed edge index from path[i-1] to path[i]
        const u = mr.path[i - 1], v = mr.path[i]
        for (let e = this.g.adjOff[u]; e < this.g.adjOff[u + 1]; e++) if (this.g.adjDst[e] === v) return e
      }
    }
    return undefined
  }

  private checkActivePaths(): void {
    for (const mr of this.missions.values()) {
      if (mr.leg !== 'TO_SCENE' && mr.leg !== 'TO_FACILITY') continue
      const edgeIdx = this.edgeAheadOf(mr)
      if (edgeIdx !== undefined && this.closedEdges.has(edgeIdx)) this.rerouteFrom(mr)
    }
  }

  // ---- director scripts (§13.1) ----
  // Official Mock: nearest PHC lacks CARDIOLOGY (breadcrumb NO_SPECIALTY), CHC ≈25km has cardiologist.
  runMockScript(): { villageName: string; villageNode: number; facBName: string; facBId: number; facCName: string; facCId: number } | null {
    // Official Mock: nearest PHC lacks CARDIOLOGY (breadcrumb NO_SPECIALTY), CHC ≈25km has cardiologist.
    // Deterministic config: strip CARDIOLOGY everywhere except designated C; B = nearest PHC to village.
    const village = this.world.villages.find((v) => v.name === 'Rampura Kalan') ?? this.world.villages[0]
    for (const f of this.world.facilities) {
      f.specs = f.specs.filter((s) => s !== 'CARDIOLOGY')
      f.doctors = f.doctors.filter((d) => d.spec !== 'CARDIOLOGY')
    }
    const dist = (n: number): number => hav(this.world.lat[village.node], this.world.lng[village.node], this.world.lat[n], this.world.lng[n])
    const phcs = [...this.world.facilities].filter((f) => f.tier === 'PHC').sort((a, b) => dist(a.node) - dist(b.node))
    const chcPool = [...this.world.facilities].filter((f) => f.tier === 'CHC').sort((a, b) => dist(b.node) - dist(a.node))
    if (!phcs.length || !chcPool.length) return null
    const facB = phcs[0]
    const facC = chcPool[0] // farthest CHC ≈ the "25km away" one
    facC.specs.push('CARDIOLOGY')
    facC.doctors.push({ spec: 'CARDIOLOGY', onDutyUntil: this.clockS + 8 * 3600 })
    const emg = this.spawnRandomEmergency(village.node, 'DELTA', 'CARDIOLOGY', 'FAMILY')
    void emg
    return { villageName: village.name, villageNode: village.node, facBName: facB.name, facBId: facB.id, facCName: facC.name, facCId: facC.id }
  }

  runMciScript(): void {
    // highway collision: 12 casualties over 60s RED/YELLOW/GREEN -> DELTA/CHARLIE/BRAVO
    const site = this.world.villages[(this.rng() * this.world.villages.length) | 0].node
    const tags: [Urgency, Specialty, number][] = [
      ['DELTA', 'TRAUMA', 4], ['CHARLIE', 'SURGERY', 5], ['BRAVO', 'GENERAL', 3],
    ]
    let delay = 0
    for (const [u, sp, n] of tags) {
      for (let i = 0; i < n; i++) {
        setTimeoutSim(this, delay, () => {
          const emg = this.spawnRandomEmergency(site, u, sp, 'ASHA')
          void emg
        })
        delay += 5
      }
    }
    this.influxUntilS = this.clockS + 300
  }

  runDisasterScript(): void {
    this.weatherForceMm = 5
    this.chaos('WEATHER_SPIKE')
    for (let i = 0; i < 3; i++) this.chaos('CLOSE_RANDOM_ROAD')
    // bridge cut: island one village by closing all its incident edges
    const island = this.world.villages.find((v) => !this.isFacilityNode(v.node)) ?? this.world.villages[0]
    for (let e = this.g.adjOff[island.node]; e < this.g.adjOff[island.node + 1]; e++) this.closedEdges.add(e)
    this.push('CLOSURE', `bridge cut: ${island.name} isolated (temporary island)`)
    for (let i = 1; i <= 8; i++) {
      setTimeoutSim(this, i * 22, () => { this.spawnRandomEmergency(undefined, undefined, undefined, 'PHC_REFERRAL') })
    }
  }

  isFacilityNode(node: number): boolean {
    return this.world.facilities.some((f) => f.node === node)
  }
}

// tiny scheduler inside sim-time (executed by the per-second tick)
type Task = { atS: number; fn: () => void }
const tasks = new WeakMap<SimEngine, Task[]>()
function tasksOf(s: SimEngine): Task[] {
  let t = tasks.get(s)
  if (!t) { t = []; tasks.set(s, t) }
  return t
}
export function setTimeoutSim(s: SimEngine, delayS: number, fn: () => void): void {
  tasksOf(s).push({ atS: s.clockS + delayS, fn })
}
export function runDueTasks(s: SimEngine): void {
  const list = tasksOf(s)
  for (let i = list.length - 1; i >= 0; i--) {
    if (s.clockS >= list[i].atS) {
      const task = list[i]
      list.splice(i, 1)
      task.fn()
    }
  }
}

// helpers
function seededZones(seed: number) {
  const rng = mulberry32(seed + 7)
  const zones: { minLat: number; minLng: number; maxLat: number; maxLng: number }[] = []
  for (let i = 0; i < 3; i++) {
    const h = 0.12 + rng() * 0.15, w = 0.18 + rng() * 0.2
    const la = 24.8 + rng() * (25.3 - 24.8 - h), lo = 76.35 + rng() * (77.0 - 76.35 - w)
    zones.push({ minLat: la, minLng: lo, maxLat: la + h, maxLng: lo + w })
  }
  return zones
}
function hav(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371000, rad = Math.PI / 180
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
export function cumulative(g: GraphView, path: number[]): number[] {
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    let w = 0
    const u = path[i - 1], v = path[i]
    for (let e = g.adjOff[u]; e < g.adjOff[u + 1]; e++) if (g.adjDst[e] === v) { w = g.adjW[e]; break }
    cum.push(cum[i - 1] + w)
  }
  return cum
}
function triage(a: RuntimeEmergency, b: RuntimeEmergency, s: SimEngine): number {
  const ra = CONST.SEVERITY_RANK[a.urgency], rb = CONST.SEVERITY_RANK[b.urgency]
  if (ra !== rb) return ra - rb
  if (a.filedAt !== b.filedAt) return a.filedAt - b.filedAt
  return nameOf(s.world, a.village).localeCompare(nameOf(s.world, b.village))
}
function weightedUrgency(rng: Rng): Urgency {
  return weighted(rng, URG_DIST)
}
function weightedSpec(rng: Rng): Specialty {
  return weighted(rng, SPEC_WEIGHTS)
}
function weightedCaller(rng: Rng): Emergency['caller'] {
  return weighted(rng, CALLERS)
}
function weighted<T>(rng: Rng, pairs: readonly [T, number][]): T {
  let tot = 0
  for (const [, w] of pairs) tot += w
  let r = rng() * tot
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v }
  return pairs[pairs.length - 1][0]
}
export function nameOf(world: World, node: number): string {
  const v = world.villages.find((vv) => vv.node === node)
  return v?.name ?? `node ${node}`
}
function urgency(u: Urgency): string { return u }
function pct(x: number): string { return `${Math.round(x * 100)}%` }
function fmtDur(sec: number): string {
  const m = Math.floor(Math.abs(sec) / 60), s = Math.round(Math.abs(sec) % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
function emptyKpis(): Kpis {
  return {
    responseByTier: { ECHO: [], DELTA: [], CHARLIE: [], BRAVO: [], ALPHA: [] },
    completedByTier: { ECHO: 0, DELTA: 0, CHARLIE: 0, BRAVO: 0, ALPHA: 0 },
    slaOkByTier: { ECHO: 0, DELTA: 0, CHARLIE: 0, BRAVO: 0, ALPHA: 0 },
    missionsCompleted: 0, busyUnitS: 0, elapsedUnitS: 1,
    costSum: { responseS: 0, onSceneS: 0, transportS: 0, waitS: 0 },
  }
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

// re-export types consumed by UI layer
export type { Ambulance }
