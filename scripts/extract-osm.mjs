#!/usr/bin/env node
// CareGrid — Baran district OSM extraction (dev-time only, never shipped)
// Output: CareGrid World JSON -> stdout. All logs -> stderr.
import { unlinkSync } from 'node:fs'

const BBOX = { s: 24.75, w: 76.3, n: 25.35, e: 77.05 }
const OVERPASS = 'https://overpass-api.de/api/interpreter'
const TIMEOUT_MS = 6 * 60 * 1000
const MAX_NODES = 50000
const SEED = 42

const SPEED_KMH = [60, 40, 25]
const CLASS_OF = {
  motorway: 0, trunk: 0, primary: 0, secondary: 0,
  tertiary: 1, unclassified: 1, residential: 1, service: 1,
  track: 2,
}
const HIGHWAY_RE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track|service)$/

const VILLAGE_NAMES = [
  'Rampura Kalan', 'Atru', 'Shahabad', 'Chhabra', 'Kishanganj', 'Mangrol', 'Anta', 'Baran',
  'Bhanwargarh', 'Kawai', 'Chhipabarod', 'Piplda', 'Sursagar', 'Kelwara', 'Bamori', 'Nandner',
  'Gugor', 'Sahada', 'Moondla', 'Karjara', 'Phulbari', 'Sehrol', 'Dabri', 'Kherli',
  'Rani Barod', 'Deori', 'Talera', 'Sualgiri', 'Balwara', 'Harnawda', 'Itawa', 'Bilasgarh',
  'Mandola', 'Rawati', 'Uparana', 'Sanwar', 'Jhalod', 'Patan', 'Laharadara', 'Borkhera',
  'Kanya Dah', 'Maytha', 'Gordhanpura', 'Nayanagar', 'Ummedganj', 'Panchwati', 'Sakalda', 'Bhatwara',
  'Khajuri Sur', 'Rata Kalan', 'Nadiya', 'Kuwari', 'Banuni', 'Laxmipura', 'Jagpura', 'Dhumarkalan',
]

function log(...a) { console.error('[extract]', ...a) }
function die(msg) { console.error('[extract] FATAL:', msg); process.exit(1) }

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class UF {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x] } return x }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb }
}

async function fetchOverpass() {
  const q = `[out:json][timeout:300][bbox:${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}];
way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track|service)$"];
node[place=village];
out body;>; out skel qt;`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    log('querying Overpass…')
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
    return await res.json()
  } finally { clearTimeout(timer) }
}

function buildGraph(data) {
  const latlng = new Map()
  const villagesOsm = []
  for (const el of data.elements) {
    if (el.type === 'node') {
      if (el.tags?.place === 'village' && el.tags?.name) {
        villagesOsm.push({ osmId: el.id, lat: el.lat, lng: el.lon, name: el.tags.name, pop: Number(el.tags.population) || 800 })
      } else if (el.lat !== undefined) {
        latlng.set(el.id, [el.lat, el.lon])
      }
    }
  }
  const ways = []
  for (const el of data.elements) {
    if (el.type === 'way' && el.nodes?.length > 1 && el.tags?.highway && HIGHWAY_RE.test(el.tags.highway)) {
      ways.push({ nodes: el.nodes, cls: CLASS_OF[el.tags.highway] ?? 1 })
    }
  }
  // remap osm ids -> dense ids, only nodes referenced by kept ways
  const idmap = new Map()
  const lat = [], lng = []
  for (const w of ways) {
    for (let i = 0; i < w.nodes.length; i++) {
      const osmId = w.nodes[i]
      if (!latlng.has(osmId)) continue
      let id = idmap.get(osmId)
      if (id === undefined) { id = lat.length; idmap.set(osmId, id); lat.push(latlng.get(osmId)[0]); lng.push(latlng.get(osmId)[1]) }
      w.nodes[i] = id
    }
  }
  return { lat, lng, ways, villagesOsm }
}

function largestComponent(n, ways) {
  const uf = new UF(n)
  for (const w of ways) for (let i = 1; i < w.nodes.length; i++) {
    const a = w.nodes[i - 1], b = w.nodes[i]
    if (Number.isInteger(a) && Number.isInteger(b)) uf.union(a, b)
  }
  const size = new Int32Array(n)
  for (let v = 0; v < n; v++) size[uf.find(v)]++
  let bestRoot = -1, bestSize = 0
  for (let v = 0; v < n; v++) if (size[v] > bestSize) { bestSize = size[v]; bestRoot = v }
  const keep = new Uint8Array(n)
  for (let v = 0; v < n; v++) if (uf.find(v) === bestRoot) keep[v] = 1
  return { keep, size: bestSize }
}

// Rewire chains through sampled degree-2 nodes until nodeCount <= cap.
function simplifyToCap(lat, lng, ways, cap) {
  const n = lat.length
  const deg = new Int32Array(n)
  for (const w of ways) for (const v of w.nodes) if (Number.isInteger(v)) deg[v]++

  // adjacency: map node -> [{to, lenM, cls}]
  const adj = Array.from({ length: n }, () => [])
  const seen = new Set()
  const addEdge = (a, b, cls) => {
    if (a === b || !Number.isInteger(a) || !Number.isInteger(b)) return
    const key = a < b ? a * n + b : b * n + a
    const lenM = haversineM(lat[a], lng[a], lat[b], lng[b])
    adj[a].push({ to: b, lenM, cls })
    adj[b].push({ to: a, lenM, cls })
    seen.add(key)
  }
  for (const w of ways) for (let i = 1; i < w.nodes.length; i++) addEdge(w.nodes[i - 1], w.nodes[i], w.cls)

  const alive = new Uint8Array(n).fill(1)
  let aliveCount = n
  const dropProb = Math.min(0.95, 1 - cap / n)
  const rnd = mulberry32(SEED)

  // iterative pass: remove random degree-2 chain nodes, splicing neighbors
  const order = []
  for (let v = 0; v < n; v++) if (deg[v] === 2) order.push(v)
  for (let i = order.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0;[order[i], order[j]] = [order[j], order[i]] }

  for (const v of order) {
    if (aliveCount <= cap) break
    if (!alive[v] || adj[v].length !== 2) continue
    const [e1, e2] = adj[v]
    if (e1.to === e2.to) continue
    // splice: connect e1.to <-> e2.to keeping longer class semantics (use max class index = slower/simpler)
    const len = e1.lenM + e2.lenM
    const cls = Math.max(e1.cls, e2.cls)
    alive[v] = 0; aliveCount--
    adj[e1.to] = adj[e1.to].filter((e) => e.to !== v)
    adj[e2.to] = adj[e2.to].filter((e) => e.to !== v)
    adj[e1.to].push({ to: e2.to, lenM: len, cls })
    adj[e2.to].push({ to: e1.to, lenM: len, cls })
    void dropProb
  }

  // compact node ids
  const remap = new Int32Array(n).fill(-1)
  const nlat = [], nlng = []
  for (let v = 0; v < n; v++) if (alive[v]) { remap[v] = nlat.length; nlat.push(lat[v]); nlng.push(lng[v]) }
  // dedupe edges (keep min length per pair, prefer better class)
  const emap = new Map()
  for (let a = 0; a < n; a++) {
    if (!alive[a]) continue
    for (const e of adj[a]) {
      if (!alive[e.to]) continue
      const ra = remap[a], rb = remap[e.to]
      if (ra >= rb) continue
      const key = ra * nlat.length + rb
      const prev = emap.get(key)
      if (!prev || e.lenM < prev.lenM || (e.lenM === prev.lenM && e.cls < prev.cls)) emap.set(key, { a: ra, b: rb, lenM: e.lenM, cls: e.cls })
    }
  }
  return { lat: nlat, lng: nlng, edges: [...emap.values()] }
}

function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000, rad = Math.PI / 180
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function snapNearest(latArr, lngArr, pLat, pLng) {
  let best = 0, bd = Infinity
  for (let i = 0; i < latArr.length; i++) {
    const dx = (latArr[i] - pLat) * 111320, dy = (lngArr[i] - pLng) * 102000
    const d = dx * dx + dy * dy
    if (d < bd) { bd = d; best = i }
  }
  return best
}

function seedFacilities(lat, lng) {
  const rnd = mulberry32(SEED)
  const EXTRA_SPECS = ['CARDIOLOGY', 'SURGERY', 'TRAUMA']
  const mkMeds = (tier) => {
    const base = { DH: 120, CHC: 80, PHC: 40, HSC: 20 }[tier]
    return ['Paracetamol', 'ORS', 'Atropine', 'Streptokinase'].map((drug) => ({
      drug, qty: Math.max(4, Math.round(base * (0.6 + rnd() * 0.8))),
      expiresAt: 3600 * 24 * (2 + Math.floor(rnd() * 12)), // sim-hours from midnight day0
    }))
  }
  const mkDoctors = (specs) => specs.map((spec) => ({ spec, onDutyUntil: 36000 + Math.floor(rnd() * 28800) })) // 18:00 .. 26:00 sim-seconds
  const f = []
  const push = (name, tier, pLat, pLng, specs, beds) => {
    f.push({ name, tier, pLat, pLng, specs, beds, meds: mkMeds(tier), doctors: mkDoctors(specs) })
  }
  push('DH Baran', 'DH', 25.105, 76.515, ['CARDIOLOGY', 'GENERAL', 'OBSTETRIC', 'PEDIATRIC', 'SURGERY', 'TRAUMA'], 40)
  push('DH North', 'DH', 25.245, 76.785, ['CARDIOLOGY', 'GENERAL', 'OBSTETRIC', 'PEDIATRIC', 'SURGERY', 'TRAUMA'], 40)
  const chcPts = [['CHC Atru', 24.905, 76.585], ['CHC Shahabad', 24.985, 76.935], ['CHC Chhabra', 24.905, 76.715],
    ['CHC Kishanganj', 25.255, 76.985], ['CHC Anta', 25.185, 76.485], ['CHC Mangrol', 25.115, 76.865]]
  for (const [nm, la, lo] of chcPts) {
    const specs = ['GENERAL', 'OBSTETRIC', 'PEDIATRIC']
    if (rnd() < 0.5) specs.push(EXTRA_SPECS[(rnd() * EXTRA_SPECS.length) | 0])
    push(nm, 'CHC', la + (rnd() - 0.5) * 0.01, lo + (rnd() - 0.5) * 0.01, [...new Set(specs)], 20)
  }
  const phcBase = [['PHC Kelwara', 24.83, 76.44], ['PHC Bamori', 24.88, 76.92], ['PHC Gugor', 25.02, 76.62], ['PHC Sahada', 25.08, 76.99],
    ['PHC Moondla', 24.79, 76.68], ['PHC Karjara', 25.22, 76.62], ['PHC Sehrol', 25.31, 76.82], ['PHC Talera', 24.95, 76.47],
    ['PHC Rawati', 25.16, 76.94], ['PHC Uparana', 24.86, 76.56], ['PHC Sanwar', 25.27, 76.53], ['PHC Patan', 25.0, 76.81],
    ['PHC Borkhera', 24.92, 76.85], ['PHC Itawa', 25.13, 76.71]]
  for (const [nm, la, lo] of phcBase) push(nm, 'PHC', la + (rnd() - 0.5) * 0.02, lo + (rnd() - 0.5) * 0.02, ['GENERAL'], 8)
  for (let i = 0; i < 30; i++) {
    const la = BBOX.s + rnd() * (BBOX.n - BBOX.s), lo = BBOX.w + rnd() * (BBOX.e - BBOX.w)
    push(`HSC ${String(i + 1).padStart(2, '0')}`, 'HSC', la, lo, [], 0)
  }
  return f
}

async function main() {
  let data
  try {
    data = await fetchOverpass()
  } catch (e) {
    console.error('[extract] FATAL: overpass failed:', String(e))
    try { unlinkSync(new URL('../public/district.json', import.meta.url)) } catch { /* no stale file */ }
    process.exit(1)
  }
  const { lat, lng, ways } = buildGraph(data)
  log(`raw nodes=${lat.length} ways=${ways.length}`)
  const cc = largestComponent(lat.length, ways.filter((w) => w.nodes.every(Number.isInteger)))
  log(`largest CC=${cc.size}`)
  let keptWays = ways.map((w) => ({ nodes: w.nodes.filter(Number.isInteger), cls: w.cls })).filter((w) => w.nodes.length > 1 && cc.keep[w.nodes[0]])
  let g = simplifyToCap(lat, lng, keptWays, MAX_NODES)
  log(`after simplify: nodes=${g.lat.length} edges=${g.edges.length}`)

  // CSR
  const dirEdges = []
  for (const e of g.edges) {
    for (const [a, b] of [[e.a, e.b], [e.b, e.a]]) {
      const wgt = Math.round(e.lenM / (SPEED_KMH[e.cls] * 1000 / 3600))
      dirEdges.push([a, b, wgt, Math.round(e.lenM), e.cls])
    }
  }
  dirEdges.sort((x, y) => x[0] - y[0])
  const N = g.lat.length, M = dirEdges.length
  const adjOff = new Uint32Array(N + 1), adjDst = new Uint32Array(M), adjW = new Uint32Array(M), adjLen = new Uint32Array(M), adjCls = new Uint8Array(M)
  for (let i = 0; i < M; i++) { adjOff[dirEdges[i][0] + 1]++; adjDst[i] = dirEdges[i][1]; adjW[i] = dirEdges[i][2]; adjLen[i] = dirEdges[i][3]; adjCls[i] = dirEdges[i][4] }
  for (let i = 0; i < N; i++) adjOff[i + 1] += adjOff[i]

  // villages: OSM named first, fill from fixed list, snap to graph
  const rnd = mulberry32(SEED)
  const osmVillages = data.elements.filter((el) => el.type === 'node' && el.tags?.place === 'village' && el.tags?.name)
    .sort((a, b) => (Number(b.tags.population) || 0) - (Number(a.tags.population) || 0)).slice(0, 150)
    .map((v) => ({ lat: v.lat, lng: v.lon, name: v.tags.name, pop: Number(v.tags.population) || 800 }))
  const villages = []
  const usedNames = new Set(osmVillages.map((v) => v.name))
  const pool = VILLAGE_NAMES.filter((nm) => !usedNames.has(nm))
  const all = [...osmVillages]
  while (all.length < 150 && pool.length) all.push({ lat: BBOX.s + rnd() * (BBOX.n - BBOX.s), lng: BBOX.w + rnd() * (BBOX.e - BBOX.w), name: pool.shift(), pop: 300 + Math.floor(rnd() * 2500) })
  while (all.length < 150) all.push({ lat: BBOX.s + rnd() * (BBOX.n - BBOX.s), lng: BBOX.w + rnd() * (BBOX.e - BBOX.w), name: `Village ${villages.length}`, pop: 300 + Math.floor(rnd() * 2500) })
  for (const v of all) villages.push({ node: snapNearest(g.lat, g.lng, v.lat, v.lng), name: v.name, pop: v.pop })

  // facilities + ambulances
  const facSeeds = seedFacilities(g.lat, g.lng)
  const facilities = facSeeds.map((fs, id) => ({
    id, node: snapNearest(g.lat, g.lng, fs.pLat, fs.pLng), name: fs.name, tier: fs.tier,
    specs: fs.specs, bedsTotal: fs.beds, bedsFree: fs.beds, meds: fs.meds, doctors: fs.doctors,
  }))
  const ambulances = []
  let als = 0, bls = 0
  const dhchc = facilities.filter((fc) => fc.tier === 'DH' || fc.tier === 'CHC')
  const others = facilities.filter((fc) => fc.tier === 'PHC' || fc.tier === 'HSC')
  for (let i = 0; i < 8; i++) { const host = dhchc[i % dhchc.length]; ambulances.push({ id: ambulances.length, callsign: `ALS-${++als}`, cls: 'ALS', state: 'AVAILABLE', at: host.node, missionId: -1, edgeProgress: 0 }) }
  for (let i = 0; i < 16; i++) { const host = others.length ? others[i % others.length] : dhchc[i % dhchc.length]; ambulances.push({ id: ambulances.length, callsign: `BLS-${++bls}`, cls: 'BLS', state: 'AVAILABLE', at: host.node, missionId: -1, edgeProgress: 0 }) }

  const out = {
    attribution: '© OpenStreetMap contributors (ODbL)',
    source: 'osm', seed: SEED, nodeCount: N,
    bbox: [BBOX.s, BBOX.w, BBOX.n, BBOX.e],
    lat: g.lat.map((v) => Math.round(v * 1e6) / 1e6),
    lng: g.lng.map((v) => Math.round(v * 1e6) / 1e6),
    adjOff: Array.from(adjOff), adjDst: Array.from(adjDst), adjW: Array.from(adjW),
    adjLen: Array.from(adjLen), adjCls: Array.from(adjCls),
    villages, facilities, ambulances,
    stats: { nodes: N, directedEdges: M, undirectedRoads: g.edges.length, villages: villages.length, facilities: facilities.length, ambulances: ambulances.length },
  }
  process.stdout.write(JSON.stringify(out))
  log(`done: ${JSON.stringify(out.stats)} bytes=${JSON.stringify(out).length}`)
}

main().catch((e) => { console.error('[extract] FATAL:', e); process.exit(1) })
