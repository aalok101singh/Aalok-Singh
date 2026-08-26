// 2km grid spatial index — §6.2.5. Tracks ambulance positions; ring-outward nearest queries.
import type { NodeId } from './types'
import type { GraphView } from './pathfind'

const CELL_DEG_LAT = 2 / 111 // ≈2km
const CELL_DEG_LNG = 2 / 102 // at ~25°N

export class SpatialIndex {
  private cellW: number
  private cellH: number
  private buckets: Map<number, number[]> = new Map() // cellKey -> ambIds
  private ambCell: Int32Array // ambId -> cellKey
  private minLat = Infinity; private minLng = Infinity

  constructor(private g: GraphView, private capacity: number) {
    this.cellH = CELL_DEG_LAT
    this.cellW = CELL_DEG_LNG
    this.ambCell = new Int32Array(capacity).fill(-1)
  }

  private keyOf(lat: number, lng: number): number {
    const cy = Math.floor((lat - this.minLat) / this.cellH)
    const cx = Math.floor((lng - this.minLng) / this.cellW)
    return ((cx & 0xffff) << 16) | (cy & 0xffff)
  }

  /** Compute bounds once from graph, then insert ambulances. */
  build(positions: { id: number; node: NodeId }[]): void {
    this.buckets.clear()
    let mnLa = Infinity, mnLo = Infinity
    for (let i = 0; i < this.g.nodeCount; i++) {
      if (this.g.lat[i] < mnLa) mnLa = this.g.lat[i]
      if (this.g.lng[i] < mnLo) mnLo = this.g.lng[i]
    }
    this.minLat = mnLa - 0.01; this.minLng = mnLo - 0.01
    for (const p of positions) this.move(p.id, p.node)
  }

  move(ambId: number, node: NodeId): void {
    const prev = this.ambCell[ambId]
    if (prev !== -1) {
      const arr = this.buckets.get(prev)
      if (arr) {
        const ix = arr.indexOf(ambId)
        if (ix !== -1) arr.splice(ix, 1)
      }
    }
    const key = this.keyOf(this.g.lat[node], this.g.lng[node])
    this.ambCell[ambId] = key
    let arr = this.buckets.get(key)
    if (!arr) { arr = []; this.buckets.set(key, arr) }
    arr.push(ambId)
  }

  /** Nearest unit of class filter by haversine; rings outward up to maxRing cells. */
  nearest(
    node: NodeId,
    available: (ambId: number) => boolean,
    positions: (ambId: number) => NodeId,
    maxRing = 24,
  ): { ambId: number; distM: number } | null {
    const la = this.g.lat[node], lo = this.g.lng[node]
    const ccx = Math.floor((lo - this.minLng) / this.cellW)
    const ccy = Math.floor((la - this.minLat) / this.cellH)
    let best: { ambId: number; distM: number } | null = null
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const arr = this.buckets.get((((ccx + dx) & 0xffff) << 16) | ((ccy + dy) & 0xffff))
          if (!arr) continue
          for (const ambId of arr) {
            if (!available(ambId)) continue
            const nd = positions(ambId)
            const d = hav(la, lo, this.g.lat[nd], this.g.lng[nd])
            if (!best || d < best.distM) best = { ambId, distM: d }
          }
        }
      }
      if (best && ring >= 1) break // found within inner rings — good enough ordering
    }
    return best
  }
}

function hav(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371000, rad = Math.PI / 180
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
