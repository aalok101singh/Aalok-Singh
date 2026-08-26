// World loading: district.json -> CSR, or seeded procedural generation (§7.2).
import { mulberry32 } from './rng'
import { buildWorld } from './graph'
import { haversineM } from './pathfind'
import type { World } from './types'

export type Preset = 'FULL' | 'MED' | 'DEMO'

const PRESET_NODES: Record<Preset, number> = { FULL: 50000, MED: 5000, DEMO: 600 }
const PRESET_NEIGHBORS: Record<Preset, number> = { FULL: 4, MED: 3, DEMO: 2 }
// v1.1 D8 HARD FLOORS: FULL ≥50K nodes / ≥200K directed CSR edges / ≥5,200 villages — floors, never targets
const PRESET_EDGES_FLOOR: Record<Preset, number> = { FULL: 200000, MED: 20000, DEMO: 1500 }
const PRESET_VILLAGES: Record<Preset, number> = { FULL: 5200, MED: 1500, DEMO: 300 }

const VILLAGE_NAMES = [
  'Rampura Kalan', 'Atru', 'Shahabad', 'Chhabra', 'Kishanganj', 'Mangrol', 'Anta', 'Baran',
  'Bhanwargarh', 'Kawai', 'Chhipabarod', 'Piplda', 'Sursagar', 'Kelwara', 'Bamori', 'Nandner',
  'Gugor', 'Sahada', 'Moondla', 'Karjara', 'Phulbari', 'Sehrol', 'Dabri', 'Kherli',
  'Rani Barod', 'Deori', 'Talera', 'Sualgiri', 'Balwara', 'Harnawda', 'Itawa', 'Bilasgarh',
]

export async function loadDistrictJson(): Promise<World | null> {
  try {
    const res = await fetch('/district.json')
    if (!res.ok) return null
    return buildWorld(await res.json())
  } catch {
    return null
  }
}

export function snapNearest(lat: Float64Array, lng: Float64Array, pLa: number, pLo: number): number {
  let best = 0
  let bd = Infinity
  for (let v = 0; v < lat.length; v++) {
    const d = haversineM(lat[v], lng[v], pLa, pLo)
    if (d < bd) { bd = d; best = v }
  }
  return best
}

export function proceduralWorld(seed: number, preset: Preset): World {
  const rng = mulberry32(seed)
  const n = PRESET_NODES[preset]
  const kNeighbors = PRESET_NEIGHBORS[preset]
  const BBOX: [number, number, number, number] = [24.75, 76.3, 25.35, 77.05]
  const [s, w, bn, be] = BBOX

  // jittered lattice nodes (§7.2 hubs -> villages as one lattice with tiered density)
  const lat = new Float64Array(n)
  const lng = new Float64Array(n)
  const aspect = (be - w) / ((bn - s) * Math.cos((25 * Math.PI) / 180))
  let cols = Math.max(1, Math.ceil(Math.sqrt(n / aspect)))
  let rows = Math.max(1, Math.ceil(n / cols))
  let i = 0
  for (let r = 0; r < rows && i < n; r++) {
    for (let c = 0; c < cols && i < n; c++) {
      lat[i] = s + ((r + 0.5 + (rng() - 0.5) * 0.9) / rows) * (bn - s)
      lng[i] = w + ((c + 0.5 + (rng() - 0.5) * 0.9) / cols) * (be - w)
      i++
    }
  }

  // edges: each node -> k nearest higher-index neighbors via coarse buckets
  const edges: { a: number; b: number; lenM: number; cls: number }[] = []
  const seen = new Set<number>()
  const addEdge = (a: number, b: number): void => {
    if (a === b) return
    const key = a < b ? a * n + b : b * n + a
    if (seen.has(key)) return
    seen.add(key)
    const lenM = haversineM(lat[a], lng[a], lat[b], lng[b])
    edges.push({ a, b, lenM, cls: lenM > 8000 ? 0 : lenM > 3000 ? 1 : 2 })
  }
  const bucket = new Map<number, number[]>()
  const cellDeg = Math.max(2 / 111, Math.sqrt((bn - s) * (be - w) / n))
  for (let v = 0; v < n; v++) {
    const key = (((Math.floor(lat[v] / cellDeg) & 0xffff) << 16)) | (Math.floor(lng[v] / cellDeg) & 0xffff)
    let arr = bucket.get(key)
    if (!arr) { arr = []; bucket.set(key, arr) }
    arr.push(v)
  }
  // neighbor candidates per node — bounded selection keeps memory flat on 50K-node worlds
  const CAND_CAP = 48
  const candCache: { u: number; d: number }[][] = []
  for (let v = 0; v < n; v++) {
    let cands: { u: number; d: number }[] = [{ u: -1, d: Infinity }]
    const cx = Math.floor(lat[v] / cellDeg), cy = Math.floor(lng[v] / cellDeg)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const arr = bucket.get((((cx + dx) & 0xffff) << 16) | ((cy + dy) & 0xffff))
        if (!arr) continue
        for (const u of arr) {
          if (u === v) continue
          const d = haversineM(lat[v], lng[v], lat[u], lng[u])
          if (cands.length < CAND_CAP || d < cands[cands.length - 1].d) {
            cands.push({ u, d })
          }
        }
      }
    }
    cands = cands.filter((c) => c.u !== -1).sort((p, q) => p.d - q.d).slice(0, CAND_CAP)
    candCache.push(cands)
    for (let j = 0; j < Math.min(kNeighbors, cands.length); j++) addEdge(v, cands[j].u)
  }

  bridgeComponents(n, lat, lng, edges, addEdge)

  // grid-based snapper: reuse the lattice buckets; expand rings, fall back to full scan
  const snapper = (pLa: number, pLo: number): number => {
    const cx = Math.floor(pLa / cellDeg), cy = Math.floor(pLo / cellDeg)
    for (let ring = 1; ring <= Math.max(cols, rows); ring++) {
      let best = -1, bd = Infinity
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring && !(ring === 1)) continue
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue
          const arr = bucket.get((((cx + dx) & 0xffff) << 16) | ((cy + dy) & 0xffff))
          if (!arr) continue
          for (const u of arr) {
            const d = haversineM(lat[u], lng[u], pLa, pLo)
            if (d < bd) { bd = d; best = u }
          }
        }
      }
      if (best !== -1) return best
    }
    return snapNearest(lat, lng, pLa, pLo)
  }

  return finishWorld(BBOX, lat, lng, edges, rng, seed, preset, candCache, addEdge, snapper)
}

/** Union-find over built edges; bridge each minority component to its nearest foreign node. */
function bridgeComponents(
  n: number,
  lat: Float64Array, lng: Float64Array,
  edges: { a: number; b: number; lenM: number; cls: number }[],
  addEdge: (a: number, b: number) => void,
): void {
  const parent = new Int32Array(n)
  for (let v = 0; v < n; v++) parent[v] = v
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb }
  const byRoot = new Map<number, number[]>()
  for (let v = 0; v < n; v++) {
    const r = find(v)
    let arr = byRoot.get(r)
    if (!arr) { arr = []; byRoot.set(r, arr) }
    arr.push(v)
  }
  if (byRoot.size <= 1) return
  let mainRoot = -1, mainSize = 0
  for (const [r, arr] of byRoot) if (arr.length > mainSize) { mainSize = arr.length; mainRoot = r }
  for (const [r, arr] of byRoot) {
    if (r === mainRoot) continue
    const step = Math.max(1, Math.floor(arr.length / 32))
    for (let i = 0; i < arr.length; i += step) {
      let best = -1, bd = Infinity
      for (let u = 0; u < n; u++) {
        if (find(u) === r) continue
        const d = haversineM(lat[arr[i]], lng[arr[i]], lat[u], lng[u])
        if (d < bd) { bd = d; best = u }
      }
      if (best !== -1) addEdge(arr[i], best)
    }
  }
}

function finishWorld(
  BBOX: [number, number, number, number],
  lat: Float64Array, lng: Float64Array,
  edges: { a: number; b: number; lenM: number; cls: number }[],
  rng: () => number, seed: number, preset: Preset,
  candCache?: { u: number; d: number }[][],
  addEdge?: (a: number, b: number) => void,
  snapper?: (pLa: number, pLo: number) => number,
): World {
  const n = lat.length
  // D8 v1.1 floor: widen the neighbor ring until the directed-edge count meets the preset floor
  if (candCache && addEdge) {
    let k = kNeighborsOf(preset)
    const undirectedFloor = Math.ceil(PRESET_EDGES_FLOOR[preset] / 2)
    while (edges.length < undirectedFloor && candCache.some((c) => c.length >= k)) {
      for (let v = 0; v < n; v++) {
        const c = candCache[v]
        if (k < c.length) addEdge(v, c[k].u)
      }
      k++
      if (k > 64) break // safety valve
    }
    candCache.length = 0 // free before the heavy phases below
  }

  // CSR filled directly (no intermediate tuple arrays / no giant sort)
  const M2 = edges.length * 2
  const adjOff = new Uint32Array(n + 1)
  for (const e of edges) { adjOff[e.a + 1]++; adjOff[e.b + 1]++ }
  for (let v = 0; v < n; v++) adjOff[v + 1] += adjOff[v]
  const adjDst = new Uint32Array(M2), adjW = new Uint32Array(M2), adjLen = new Uint32Array(M2), adjCls = new Uint8Array(M2)
  const cursorFill = Uint32Array.from(adjOff)
  for (const e of edges) {
    const wgt = Math.round(e.lenM / (CONST_SPEED[e.cls] * 1000 / 3600))
    const lenM = Math.round(e.lenM)
    let slot = cursorFill[e.a]++
    adjDst[slot] = e.b; adjW[slot] = wgt; adjLen[slot] = lenM; adjCls[slot] = e.cls
    slot = cursorFill[e.b]++
    adjDst[slot] = e.a; adjW[slot] = wgt; adjLen[slot] = lenM; adjCls[slot] = e.cls
  }


  // proportional counts (D8 scaling of §7.1 seeding)
  const scale = n / 50000
  const cubeRoot = Math.cbrt(scale)
  const facCounts = {
    DH: Math.max(1, Math.round(2 * cubeRoot)),
    CHC: Math.max(1, Math.round(6 * cubeRoot)),
    PHC: Math.max(2, Math.round(14 * cubeRoot)),
    HSC: Math.max(3, Math.round(30 * cubeRoot)),
  }
  const EXTRA_SPECS = ['CARDIOLOGY', 'SURGERY', 'TRAUMA'] as const
  const mkMeds = (tier: World['facilities'][number]['tier']): World['facilities'][number]['meds'] => {
    const base = { DH: 120, CHC: 80, PHC: 40, HSC: 20 }[tier]
    return ['Paracetamol', 'ORS', 'Atropine', 'Streptokinase'].map((drug) => ({
      drug,
      qty: Math.max(4, Math.round(base * (0.6 + rng() * 0.8))),
      expiresAt: 3600 * 24 * (2 + Math.floor(rng() * 12)),
    }))
  }
  const mkDoctors = (specs: string[]): World['facilities'][number]['doctors'] =>
    specs.map((spec) => ({ spec: spec as World['facilities'][number]['doctors'][number]['spec'], onDutyUntil: 36000 + Math.floor(rng() * 28800) }))

  const facilities: World['facilities'] = []
  const snap = snapper ?? ((pLa: number, pLo: number): number => snapNearest(lat, lng, pLa, pLo))
  const pushFac = (name: string, tier: World['facilities'][number]['tier'], specs: string[], beds: number): void => {
    facilities.push({
      id: facilities.length,
      node: snap(BBOX[0] + rng() * (BBOX[2] - BBOX[0]), BBOX[1] + rng() * (BBOX[3] - BBOX[1])),
      name, tier,
      specs: specs as World['facilities'][number]['specs'],
      bedsTotal: beds, bedsFree: beds,
      meds: mkMeds(tier), doctors: mkDoctors(specs),
    })
  }
  for (let j = 0; j < facCounts.DH; j++) pushFac(`DH ${j + 1}`, 'DH', ['CARDIOLOGY', 'GENERAL', 'OBSTETRIC', 'PEDIATRIC', 'SURGERY', 'TRAUMA'], 40)
  for (let j = 0; j < facCounts.CHC; j++) {
    const specs = ['GENERAL', 'OBSTETRIC', 'PEDIATRIC']
    if (rng() < 0.5) specs.push(EXTRA_SPECS[(rng() * EXTRA_SPECS.length) | 0])
    pushFac(`CHC ${j + 1}`, 'CHC', [...new Set(specs)], 20)
  }
  for (let j = 0; j < facCounts.PHC; j++) pushFac(`PHC ${j + 1}`, 'PHC', ['GENERAL'], 8)
  for (let j = 0; j < facCounts.HSC; j++) pushFac(`HSC ${String(j + 1).padStart(2, '0')}`, 'HSC', [], 0)

  const villageCount = PRESET_VILLAGES[preset] // v1.1: 5,200 / 1,500 / 300 — organizer floors
  const villages: World['villages'] = []
  for (let j = 0; j < villageCount; j++) {
    const name = VILLAGE_NAMES[j % VILLAGE_NAMES.length]
    villages.push({
      node: snap(BBOX[0] + rng() * (BBOX[2] - BBOX[0]), BBOX[1] + rng() * (BBOX[3] - BBOX[1])),
      name: villageCount <= VILLAGE_NAMES.length ? name : `${name} ${Math.floor(j / VILLAGE_NAMES.length) + 1}`,
      pop: 300 + Math.floor(rng() * 2500),
    })
  }

  const ambulances: World['ambulances'] = []
  const hostsDHCHC = facilities.filter((f) => f.tier === 'DH' || f.tier === 'CHC')
  const hostsOther = facilities.filter((f) => f.tier === 'PHC' || f.tier === 'HSC')
  const alsCount = Math.max(1, Math.round(CONST_FLEET.ALS * cubeRoot))
  const blsCount = Math.max(2, Math.round(CONST_FLEET.BLS * cubeRoot))
  for (let j = 0; j < alsCount; j++) {
    ambulances.push({ id: ambulances.length, callsign: `ALS-${j + 1}`, cls: 'ALS', state: 'AVAILABLE', at: hostsDHCHC[j % hostsDHCHC.length].node, missionId: -1, edgeProgress: 0 })
  }
  for (let j = 0; j < blsCount; j++) {
    ambulances.push({ id: ambulances.length, callsign: `BLS-${j + 1}`, cls: 'BLS', state: 'AVAILABLE', at: hostsOther[j % hostsOther.length].node, missionId: -1, edgeProgress: 0 })
  }

  return {
    source: 'procedural', seed, nodeCount: n,
    lat, lng, adjOff, adjDst, adjW, adjLen, adjCls,
    bbox: BBOX, villages, facilities, ambulances,
  }
}

const CONST_SPEED = [60, 40, 25]
const CONST_FLEET = { ALS: 8, BLS: 16 }
function kNeighborsOf(preset: Preset): number { return PRESET_NEIGHBORS[preset] }


