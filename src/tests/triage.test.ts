import { describe, expect, it } from 'vitest'
import { SimEngine } from '../engine/sim'
import { percentile } from '../engine/sim'
import { proceduralWorld } from '../engine/world'

function makeSim(seed = 42): SimEngine {
  const w = proceduralWorld(seed, 'DEMO')
  return new SimEngine(w, seed)
}

describe('deterministic arrivals & triage', () => {
  it('two sims with same seed produce identical first events', () => {
    const a = makeSim(7)
    const b = makeSim(7)
    a.running = true
    b.running = true
    for (let i = 0; i < 600; i++) { a.tick(); b.tick() }
    expect(a.clockS).toBe(b.clockS)
    expect(a.emergencies.size).toBe(b.emergencies.size)
    const ea = [...a.emergencies.values()][0]
    const eb = [...b.emergencies.values()][0]
    if (ea && eb) {
      expect(ea.urgency).toBe(eb.urgency)
      expect(ea.village).toBe(eb.village)
      expect(ea.filedAt).toBe(eb.filedAt)
    }
  })

  it('urgency distribution roughly matches spec mix', () => {
    const s = makeSim(11)
    for (let i = 0; i < 20000; i++) s.spawnRandomEmergency()
    const counts: Record<string, number> = {}
    for (const e of s.emergencies.values()) counts[e.urgency] = (counts[e.urgency] ?? 0) + 1
    const total = s.emergencies.size
    // ECHO ~5% ±3, ALPHA ~25% ±10 (loose — seeded RNG sanity, not statistics)
    expect(counts['ECHO'] / total).toBeGreaterThan(0.02)
    expect(counts['ECHO'] / total).toBeLessThan(0.09)
    expect(counts['ALPHA'] / total).toBeGreaterThan(0.15)
  })
})

describe('KPI math', () => {
  it('percentile picks P50/P90 sensibly', () => {
    const arr = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    expect(percentile(arr, 50)).toBeGreaterThanOrEqual(400)
    expect(percentile(arr, 90)).toBeGreaterThanOrEqual(900)
    expect(percentile([], 50)).toBe(0)
  })
})
