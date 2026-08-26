import { describe, expect, it } from 'vitest'
import { evaluate, waitSeconds, batchAssign, triageCompare } from '../engine/dispatch'
import type { DispatchCtx } from '../engine/dispatch'
import { proceduralWorld } from '../engine/world'
import type { Emergency } from '../engine/types'
import { CONST } from '../engine/const'

function makeCtx(seed = 42): DispatchCtx {
  const w = proceduralWorld(seed, 'DEMO')
  return {
    g: { nodeCount: w.nodeCount, lat: w.lat, lng: w.lng, adjOff: w.adjOff, adjDst: w.adjDst, adjW: w.adjW },
    facilities: w.facilities,
    closedEdges: new Set(),
    clockS: 3600 * 9,
  }
}

describe('wait model (§6.2.6)', () => {
  it('ceil(inbound/max(1,bedsFree)) * HANDOVER_SERVICE_S', () => {
    const fac = proceduralWorld(1, 'DEMO').facilities[0]
    fac.bedsFree = 3
    expect(waitSeconds(fac, 0)).toBe(0)
    expect(waitSeconds(fac, 4)).toBe(2 * CONST.HANDOVER_SERVICE_S)
    fac.bedsFree = 0
    expect(waitSeconds(fac, 2)).toBe(2 * CONST.HANDOVER_SERVICE_S) // max(1, 0)
  })
})

describe('evaluate pipeline steps 2–5', () => {
  it('marks NO_SPECIALTY for HSC and picks an eligible facility when reachable', () => {
    const ctx = makeCtx()
    const village = 3
    const ambs = [{ id: 0, at: 10, available: true }]
    const { evals, best } = evaluate(ctx, village, 'CARDIOLOGY', ambs, [])
    // every HSC must be rejected NO_SPECIALTY (no specs at all)
    for (const f of ctx.facilities.filter((x) => x.tier === 'HSC')) {
      expect(evals[f.id].eligible).toBe(false)
      expect(evals[f.id].reject).toBe('NO_SPECIALTY')
    }
    if (best) {
      const chosenFac = ctx.facilities[best.facEval.facilityId]
      expect(chosenFac.specs).toContain('CARDIOLOGY')
      expect(best.facEval.totalS).toBe(
        best.ambTravelS + CONST.ON_SCENE_S + best.facEval.travelS + best.facEval.waitS,
      )
    }
  })

  it('NO_BEDS rejection after draining beds', () => {
    const ctx = makeCtx()
    for (const f of ctx.facilities) f.bedsFree = 0
    const { evals } = evaluate(ctx, 5, 'GENERAL', [{ id: 0, at: 0, available: true }], [])
    for (const ev of evals) {
      if (!ev.eligible && ev.reject === undefined) throw new Error('expected a reject reason')
    }
    expect(evals.some((ev) => ev.reject === 'NO_BEDS')).toBe(true)
    expect(evals.some((ev) => ev.eligible)).toBe(false) // all beds drained → nothing eligible
  })

  it('closed edges yield UNREACHABLE or detour, never crash', () => {
    const ctx = makeCtx()
    // close ALL directed slots incident to one node pair chain: close every edge of node 7
    for (let e = ctx.g.adjOff[7]; e < ctx.g.adjOff[8]; e++) ctx.closedEdges.add(e)
    const { best } = evaluate(ctx, 7, 'GENERAL', [{ id: 0, at: 100, available: true }], [])
    if (best) expect(isFinite(best.facEval.totalS)).toBe(true)
  })
})

describe('batch assignment (§6.2.7)', () => {
  it('optimal total ≤ greedy total', () => {
    const w = proceduralWorld(42, 'DEMO')
    const ctx: DispatchCtx = {
      g: { nodeCount: w.nodeCount, lat: w.lat, lng: w.lng, adjOff: w.adjOff, adjDst: w.adjDst, adjW: w.adjW },
      facilities: w.facilities, closedEdges: new Set(), clockS: 36000,
    }
    const emgs: Emergency[] = [0, 1, 2].map((i) => ({
      id: i + 1, village: (i * 97) % w.nodeCount,
      urgency: 'CHARLIE', need: 'GENERAL', caller: 'FAMILY',
      filedAt: i, status: 'QUEUED', missionId: -1,
    }))
    const ambs = w.ambulances.filter((a) => a.state === 'AVAILABLE').slice(0, 5).map((a) => ({ id: a.id, at: a.at, available: true }))
    const { assignments, optimalTotal, greedyTotal } = batchAssign(ctx, emgs, ambs, [])
    expect(assignments.size).toBeGreaterThan(0)
    expect(optimalTotal).toBeLessThanOrEqual(greedyTotal + 1e-9)
  })
})

describe('triage order (§6.2.8)', () => {
  it('sorts by severity then filedAt', () => {
    const mk = (id: number, urgency: Emergency['urgency'], filedAt: number): Emergency => ({
      id, village: 0, urgency, need: 'GENERAL', caller: 'FAMILY', filedAt, status: 'QUEUED', missionId: -1,
    })
    const list = [mk(1, 'ALPHA', 0), mk(2, 'ECHO', 999), mk(3, 'DELTA', 5), mk(4, 'DELTA', 2)]
    const sorted = [...list].sort((a, b) => triageCompare(a, b, () => 0))
    expect(sorted.map((e) => e.id)).toEqual([2, 4, 3, 1])
  })
})
