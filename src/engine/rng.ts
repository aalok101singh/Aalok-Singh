// mulberry32 seeded PRNG — determinism guarantee (§8).
export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[(rng() * arr.length) | 0]
}

export function weightedPick<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  let total = 0
  for (const w of weights) total += w
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

// Knuth-Lewis exponential inter-arrival for Poisson(lambda) seconds.
export function expSeconds(rng: Rng, meanS: number): number {
  const u = Math.max(rng(), 1e-9)
  return -Math.log(u) * meanS
}
