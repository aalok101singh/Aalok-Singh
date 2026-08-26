import { MinHeap } from './heap'
import type { NodeId, PathResult } from './types'

export type { PathResult }

export interface GraphView {
  nodeCount: number
  lat: Float64Array; lng: Float64Array
  adjOff: Uint32Array; adjDst: Uint32Array; adjW: Uint32Array
}

const INF = Infinity

function finish(t0: number, stats: PathResult['stats']): PathResult['stats'] {
  return { ...stats, ms: performance.now() - t0 }
}

function reconstruct(parent: Int32Array, t: NodeId): NodeId[] {
  const path: NodeId[] = []
  let cur = t
  let guard = parent.length + 2
  while (cur !== -1 && guard-- > 0) { path.push(cur); cur = parent[cur] }
  path.reverse()
  return path[0] !== undefined && guard > 0 ? path : []
}

export interface PathOpts {
  closed?: Set<number> | null
  weatherMult?: number
  nodeMult?: Float32Array // per-node weather multiplier; edge uses max(endpoints)
  /** Wavefront streaming (§10.3): sampled settled+frontier ids; return false to abort early. */
  onProgress?: (settled: number[], frontier: number[]) => void
}

function effMult(u: number, v: number, o: PathOpts): number {
  const wm = o.weatherMult ?? 1
  const nm = o.nodeMult
  if (!nm || (nm[u] === 1 && nm[v] === 1)) return wm
  return Math.max(wm, nm[u], nm[v])
}

/** Dijkstra with early exit at target. O((V+E) log V). */
export function dijkstra(
  g: GraphView, s: NodeId, t: NodeId | null,
  opts?: PathOpts,
): PathResult {
  const closed = opts?.closed ?? null
  const t0 = performance.now()
  const stats = { ms: 0, expanded: 0, relaxed: 0, heapOps: 0 }
  const n = g.nodeCount
  const dist = new Float64Array(n).fill(INF)
  const parent = new Int32Array(n).fill(-1)
  const best = new Float64Array(n).fill(INF)
  const heap = new MinHeap(1 << 12)
  dist[s] = 0; best[s] = 0
  heap.push(0, s)
  let settled = false
  while (heap.size > 0) {
    const top = heap.pop()!
    stats.heapOps++
    const [k, u] = top as [number, number]
    if (k > best[u]) continue // lazy deletion
    stats.expanded++
    if (t !== null && u === t) { settled = true; break }
    for (let e = g.adjOff[u]; e < g.adjOff[u + 1]; e++) {
      if (closed?.has(e)) continue // closed edge index — no rebuild (§8)
      const v = g.adjDst[e]
      const nd = k + g.adjW[e] * effMult(u, v, opts ?? {})
      if (nd < best[v]) {
        best[v] = nd; dist[v] = nd; parent[v] = u
        heap.push(nd, v); stats.heapOps++
      }
      stats.relaxed++
    }
  }
  return {
    dist: t !== null ? (settled ? dist[t as NodeId] : INF) : 0,
    path: settled && t !== null ? reconstruct(parent, t) : [],
    found: settled || t === null,
    stats: finish(t0, stats),
  }
}

/** Bidirectional Dijkstra: alternate fronts; stop when topF + topB >= bestMeet. */
export function bidirectional(
  g: GraphView, s: NodeId, t: NodeId,
  opts?: PathOpts,
): PathResult {
  const closed = opts?.closed ?? null
  const t0 = performance.now()
  const stats = { ms: 0, expanded: 0, relaxed: 0, heapOps: 0 }
  const n = g.nodeCount

  // reverse CSR (cached per graph instance by caller via prepareReverse when hot)
  const radjOff = new Uint32Array(n + 1)
  for (let e = 0; e < g.adjDst.length; e++) radjOff[g.adjDst[e] + 1]++
  for (let i = 0; i < n; i++) radjOff[i + 1] += radjOff[i]
  const radjDst = new Uint32Array(g.adjDst.length)
  const radjW = new Uint32Array(g.adjW.length)
  const radjFwdIdx = new Int32Array(g.adjDst.length) // reverse slot -> forward edge index (closure check)
  const cursor = Uint32Array.from(radjOff)
  for (let u = 0; u < n; u++) {
    for (let e = g.adjOff[u]; e < g.adjOff[u + 1]; e++) {
      const v = g.adjDst[e]
      const slot = cursor[v]++
      radjDst[slot] = u; radjW[slot] = g.adjW[e]; radjFwdIdx[slot] = e
    }
  }

  const dF = new Float64Array(n).fill(INF), dB = new Float64Array(n).fill(INF)
  const pF = new Int32Array(n).fill(-1), pB = new Int32Array(n).fill(-1)
  const hF = new MinHeap(1 << 11), hB = new MinHeap(1 << 11)
  dF[s] = 0; dB[t] = 0
  hF.push(0, s); hB.push(0, t)
  let meet = -1, bestMeet = INF

  while (hF.size > 0 && hB.size > 0) {
    const pkF = hF.peek()!, pkB = hB.peek()!
    if (pkF[0] + pkB[0] >= bestMeet) break
    const useForward = pkF[0] <= pkB[0]
    if (useForward) {
      const [k, u] = hF.pop()!
      stats.heapOps++
      if (k > dF[u]) continue
      stats.expanded++
      if (dB[u] < INF && k + dB[u] < bestMeet) { bestMeet = k + dB[u]; meet = u }
      for (let e = g.adjOff[u]; e < g.adjOff[u + 1]; e++) {
        if (closed?.has(e)) continue
        const v = g.adjDst[e]
        const nd = k + g.adjW[e] * effMult(u, v, opts ?? {})
        if (nd < dF[v]) { dF[v] = nd; pF[v] = u; hF.push(nd, v); stats.heapOps++ }
        stats.relaxed++
      }
    } else {
      const [k, u] = hB.pop()!
      stats.heapOps++
      if (k > dB[u]) continue
      stats.expanded++
      if (dF[u] < INF && k + dF[u] < bestMeet) { bestMeet = k + dF[u]; meet = u }
      for (let e = radjOff[u]; e < radjOff[u + 1]; e++) {
        if (closed?.has(radjFwdIdx[e])) continue
        const v = radjDst[e]
        const nd = k + radjW[e] * effMult(u, v, opts ?? {})
        if (nd < dB[v]) { dB[v] = nd; pB[v] = u; hB.push(nd, v); stats.heapOps++ }
        stats.relaxed++
      }
    }
  }

  if (meet === -1) return { dist: INF, path: [], found: false, stats: finish(t0, stats) }
  return { dist: bestMeet, path: stitch(pF, pB, meet), found: true, stats: finish(t0, stats) }
}

function stitch(pF: Int32Array, pB: Int32Array, meet: number): NodeId[] {
  const head: NodeId[] = []
  let cur: number = meet
  let guard = pF.length + 2
  while (cur !== -1 && guard-- > 0) { head.push(cur); cur = pF[cur] }
  head.reverse()
  const tail: NodeId[] = []
  cur = pB[meet]
  guard = pB.length + 2
  while (cur !== -1 && guard-- > 0) { tail.push(cur); cur = pB[cur] }
  return [...head, ...tail]
}

/** A* with admissible heuristic haversine / 60 km-h max speed (§6.2.4). */
export function astar(
  g: GraphView, s: NodeId, t: NodeId,
  opts?: PathOpts,
): PathResult {
  const closed = opts?.closed ?? null
  const t0 = performance.now()
  const stats = { ms: 0, expanded: 0, relaxed: 0, heapOps: 0 }
  const n = g.nodeCount
  const M_PER_S_MAX = 60 * 1000 / 3600
  const gScore = new Float64Array(n).fill(INF)
  const parent = new Int32Array(n).fill(-1)
  const closedStale = new Float64Array(n).fill(INF) // min f ever pushed — lazy deletion filter
  const heap = new MinHeap(1 << 12)
  const hv = (u: number): number => haversineM(g.lat[u], g.lng[u], g.lat[t], g.lng[t]) / M_PER_S_MAX
  gScore[s] = 0
  heap.push(hv(s), s)
  let found = false
  let sinceSample = 0
  while (heap.size > 0) {
    const top = heap.pop()!
    stats.heapOps++
    const [fk, u] = top as [number, number]
    if (fk > closedStale[u]) continue // stale entry
    stats.expanded++
    if (u === t) { found = true; break }
    for (let e = g.adjOff[u]; e < g.adjOff[u + 1]; e++) {
      if (closed?.has(e)) continue
      const v = g.adjDst[e]
      const tentative = gScore[u] + g.adjW[e] * effMult(u, v, opts ?? {})
      if (tentative < gScore[v]) {
        gScore[v] = tentative
        parent[v] = u
        const f = tentative + hv(v)
        if (f < closedStale[v]) closedStale[v] = f
        heap.push(f, v); stats.heapOps++
      }
      stats.relaxed++
    }
    if (opts?.onProgress && ++sinceSample >= 256) {
      sinceSample = 0
      const settled: number[] = [], frontier: number[] = []
      for (let i = 0; i < n && settled.length < 2048; i++) if (closedStale[i] < INF) settled.push(i)
      for (let i = heap.size - 1; i >= 0 && frontier.length < 1024; i--) frontier.push((heap as unknown as { vals: Int32Array }).vals[i])
      opts.onProgress(settled, frontier)
    }
  }
  return {
    dist: found ? gScore[t] : INF,
    path: found ? reconstruct(parent, t) : [],
    found,
    stats: finish(t0, stats),
  }
}

export function haversineM(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371000, rad = Math.PI / 180
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad
  const sinSq = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(sinSq))
}
