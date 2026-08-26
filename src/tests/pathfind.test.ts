import { describe, expect, it } from 'vitest'
import { dijkstra, bidirectional, astar } from '../engine/pathfind'
import type { GraphView } from '../engine/pathfind'
import { proceduralWorld } from '../engine/world'
import { components } from '../engine/graph'

/** Tiny 5-node line graph: 0-1-2-3-4 with weights 10,20,30,40 (seconds). */
function lineGraph(): GraphView {
  const n = 5
  const adjOff = new Uint32Array(n + 1)
  const pairs: [number, number, number][] = [[0, 1, 10], [1, 2, 20], [2, 3, 30], [3, 4, 40]]
  const dir = [...pairs, ...pairs.map(([a, b, w]) => [b, a, w] as [number, number, number])].sort((a, b) => a[0] - b[0])
  const adjDst = new Uint32Array(dir.length), adjW = new Uint32Array(dir.length)
  for (let i = 0; i < dir.length; i++) { adjOff[dir[i][0] + 1]++; adjDst[i] = dir[i][1]; adjW[i] = dir[i][2] }
  for (let v = 0; v < n; v++) adjOff[v + 1] += adjOff[v]
  return {
    nodeCount: n,
    lat: Float64Array.from([25.0, 25.01, 25.02, 25.03, 25.04]),
    lng: Float64Array.from([76.5, 76.51, 76.52, 76.53, 76.54]),
    adjOff, adjDst, adjW,
  }
}

describe('pathfinders on line graph', () => {
  const g = lineGraph()

  it('dijkstra finds shortest path with early exit', () => {
    const r = dijkstra(g, 0, 4)
    expect(r.found).toBe(true)
    expect(r.dist).toBe(100)
    expect(r.path).toEqual([0, 1, 2, 3, 4])
    expect(r.stats.expanded).toBeLessThanOrEqual(5)
  })

  it('bidirectional agrees with dijkstra', () => {
    const r = bidirectional(g, 0, 4)
    expect(r.found).toBe(true)
    expect(r.dist).toBe(100)
    expect(r.path).toEqual([0, 1, 2, 3, 4])
  })

  it('astar agrees and is admissible-fast', () => {
    const r = astar(g, 0, 4)
    expect(r.found).toBe(true)
    expect(r.dist).toBe(100)
    expect(r.path[0]).toBe(0)
    expect(r.path[r.path.length - 1]).toBe(4)
  })

  it('unreachable target returns found=false', () => {
    const broken: GraphView = { ...g, adjOff: new Uint32Array([0, 1, 1, 2, 2, 2]), adjDst: new Uint32Array([1, 0]), adjW: new Uint32Array([10, 10]) }
    expect(dijkstra(broken, 0, 4).found).toBe(false)
    expect(dijkstra(broken, 0, 4).dist).toBe(Infinity)
  })
})

describe('pathfinders on DEMO procedural world', () => {
  const w = proceduralWorld(42, 'DEMO')
  const gv: GraphView = { nodeCount: w.nodeCount, lat: w.lat, lng: w.lng, adjOff: w.adjOff, adjDst: w.adjDst, adjW: w.adjW }

  it('graph is connected (single component)', () => {
    const cc = components(w)
    expect(cc.count).toBe(1)
  })

  it('all three agree on 50 random pairs', () => {
    let seed = 7
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    for (let i = 0; i < 50; i++) {
      const s = (rnd() * w.nodeCount) | 0
      const t = (rnd() * w.nodeCount) | 0
      const d1 = dijkstra(gv, s, t)
      const d2 = bidirectional(gv, s, t)
      const d3 = astar(gv, s, t)
      if (d1.found) {
        expect(d2.found).toBe(true)
        expect(d3.found).toBe(true)
        expect(Math.abs(d2.dist - d1.dist)).toBeLessThan(1e-6 * Math.max(1, d1.dist))
        expect(Math.abs(d3.dist - d1.dist)).toBeLessThan(1e-6 * Math.max(1, d1.dist))
        // path costs sum to reported dist
        let sum = 0
        for (let j = 1; j < d3.path.length; j++) sum += weightOf(gv, d3.path[j - 1], d3.path[j])
        expect(Math.abs(sum - d1.dist)).toBeLessThan(1e-6 * Math.max(1, d1.dist))
      } else {
        expect(d2.found).toBe(false)
        expect(d3.found).toBe(false)
      }
    }
  })

  it('closed edges force longer detour or disconnect', () => {
    const r0 = astar(gv, 0, 1)
    if (!r0.found) return // disconnected pair — skip
    // close every edge incident to node 0's first hop along path -> must reroute or fail, never crash
    const closed = new Set<number>()
    for (let e = w.adjOff[r0.path[0]]; e < w.adjOff[r0.path[0] + 1]; e++) closed.add(e)
    const r1 = astar(gv, 0, 1, closed)
    expect(r1.found === false || r1.dist >= r0.dist).toBe(true)
  })
})

function weightOf(g: GraphView, u: number, v: number): number {
  for (let e = g.adjOff[u]; e < g.adjOff[u + 1]; e++) if (g.adjDst[e] === v) return g.adjW[e]
  throw new Error(`no edge ${u}->${v}`)
}
