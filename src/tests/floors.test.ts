import { describe, expect, it } from 'vitest'
import { SimEngine } from '../engine/sim'
import { proceduralWorld } from '../engine/world'

describe('v1.1 D8 hard floors (organizer minimums)', () => {
  it('DEMO preset: ≥300 villages, ≥1,500 directed CSR edges', () => {
    const w = proceduralWorld(42, 'DEMO')
    expect(w.villages.length).toBeGreaterThanOrEqual(300)
    expect(w.adjDst.length).toBeGreaterThanOrEqual(1500)
  })

  it('FULL preset: ≥50K nodes, ≥200K directed CSR edges, ≥5,200 villages, 52 facilities', () => {
    const w = proceduralWorld(42, 'FULL')
    expect(w.nodeCount).toBeGreaterThanOrEqual(50000)
    expect(w.adjDst.length).toBeGreaterThanOrEqual(200000)
    expect(w.villages.length).toBeGreaterThanOrEqual(5200)
    expect(w.facilities.length).toBeGreaterThanOrEqual(52)
  }, 120_000)
})

describe('§6.2.9 ECHO preemption — dynamic resource re-allocation', () => {
  it('preempts newest non-ECHO TO_SCENE mission when fleet is exhausted', () => {
    const w = proceduralWorld(42, 'DEMO')
    const s = new SimEngine(w, 42)

    // 1) get one real mission into TO_SCENE
    const bravo = s.createEmergency(w.villages[0].node, 'BRAVO', 'GENERAL', 'FAMILY')
    s.tick()
    expect(bravo.status).toBe('ASSIGNED')

    // 2) exhaust every other unit so zero are AVAILABLE
    for (const a of w.ambulances) if (a.state === 'AVAILABLE') a.state = 'TO_SCENE'
    const busyBefore = [...s.missions.values()].filter((m) => m.leg === 'TO_SCENE').length
    expect(busyBefore).toBeGreaterThanOrEqual(1)

    // 3) ECHO arrives — must re-allocate instead of queueing forever
    const echo = s.createEmergency(w.villages[1].node, 'ECHO', 'CARDIOLOGY', 'FAMILY')
    s.tick()

    expect(echo.status).toBe('ASSIGNED') // dispatched via preempted unit
    expect(bravo.status).toBe('QUEUED') // patient re-queued, front-of-tier (filedAt preserved)
    expect(s.events.some((e) => e.text.includes('PREEMPTED'))).toBe(true)
    // never preempt ON_SCENE/TO_FACILITY/HANDOVER: the freed unit came from a TO_SCENE leg
  })
})
