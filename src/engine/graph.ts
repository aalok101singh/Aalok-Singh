import type { World } from './types'
import { CONST } from './const'

// CSR typed-array graph utilities: build from serialized world, validate (§13.2 load validation).

export interface WorldJson {
  source: 'osm' | 'procedural'; seed: number; nodeCount: number;
  bbox?: [number, number, number, number];
  lat: number[]; lng: number[];
  adjOff: number[]; adjDst: number[]; adjW: number[]; adjLen: number[]; adjCls: number[];
  villages: { node: number; name: string; pop: number }[];
  facilities: {
    id: number; node: number; name: string; tier: string; specs: string[];
    bedsTotal: number; bedsFree: number;
    meds: { drug: string; qty: number; expiresAt: number }[];
    doctors?: { spec: string; onDutyUntil: number }[];
  }[];
  ambulances: {
    id: number; callsign: string; cls: string; state: string;
    at: number; missionId: number; edgeProgress: number;
  }[];
  stats?: Record<string, number>;
}

// Union-find over graph nodes — component count + island detection at load time.
export class UnionFind {
  private p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(x: number): number { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x] } return x }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb }
}

export function components(world: Pick<World, 'nodeCount' | 'adjOff' | 'adjDst'>): { count: number; rootOf: Int32Array } {
  const uf = new UnionFind(world.nodeCount)
  for (let u = 0; u < world.nodeCount; u++) {
    for (let e = world.adjOff[u]; e < world.adjOff[u + 1]; e++) uf.union(u, world.adjDst[e])
  }
  const rootOf = new Int32Array(world.nodeCount)
  const roots = new Map<number, number>()
  for (let v = 0; v < world.nodeCount; v++) {
    const r = uf.find(v)
    let id = roots.get(r)
    if (id === undefined) { id = roots.size; roots.set(r, id) }
    rootOf[v] = id
  }
  return { count: roots.size, rootOf }
}

/** Parse district.json into a live World with typed arrays. Throws on corrupt input. */
export function buildWorld(json: unknown): World {
  const j = json as WorldJson
  if (!j || typeof j !== 'object' || !Array.isArray(j.lat) || !Array.isArray(j.adjOff) ||
    !Array.isArray(j.adjDst) || j.nodeCount !== j.lat.length) {
    throw new Error('corrupt world file')
  }
  const n = j.nodeCount
  const lat = Float64Array.from(j.lat)
  const lng = Float64Array.from(j.lng)
  const adjOff = Uint32Array.from(j.adjOff)
  const adjDst = Uint32Array.from(j.adjDst)
  const adjW = Uint32Array.from(j.adjW)
  const adjLen = Uint32Array.from(j.adjLen ?? new Array(adjDst.length).fill(0))
  const adjCls = Uint8Array.from(j.adjCls ?? new Array(adjDst.length).fill(1))
  if (adjOff.length !== n + 1 || adjDst.length !== adjW.length || adjDst.length !== adjLen.length) {
    throw new Error('corrupt CSR arrays')
  }
  // duplicate-id sanity check
  const seenFac = new Set<number>()
  for (const f of j.facilities) {
    if (seenFac.has(f.id)) throw new Error('duplicate facility id')
    seenFac.add(f.id)
    if (f.node < 0 || f.node >= n) throw new Error('facility node out of range')
  }
  return {
    source: j.source === 'osm' ? 'osm' : 'procedural',
    seed: j.seed ?? 42,
    nodeCount: n,
    lat, lng, adjOff, adjDst, adjW, adjLen, adjCls,
    bbox: j.bbox ?? [24.75, 76.3, 25.35, 77.05],
    villages: j.villages.map((v) => ({ ...v })),
    facilities: j.facilities.map((f) => ({
      id: f.id, node: f.node, name: f.name,
      tier: f.tier as World['facilities'][number]['tier'],
      specs: f.specs as World['facilities'][number]['specs'],
      bedsTotal: f.bedsTotal, bedsFree: f.bedsFree,
      meds: f.meds.map((m) => ({ ...m })),
      doctors: (f.doctors ?? []).map((d) => ({ spec: d.spec as World['facilities'][number]['doctors'][number]['spec'], onDutyUntil: d.onDutyUntil })),
    })),
    ambulances: j.ambulances.map((a) => ({
      id: a.id, callsign: a.callsign,
      cls: a.cls as World['ambulances'][number]['cls'],
      state: a.state as World['ambulances'][number]['state'],
      at: a.at, missionId: -1, edgeProgress: 0,
    })),
  }
}

/** Edge weight under weather multiplier (seconds). */
export function edgeWeightSec(baseW: number, weatherMult: number): number {
  return baseW * Math.max(1, Math.min(CONST.WEATHER_MAX_MULT, weatherMult))
}
