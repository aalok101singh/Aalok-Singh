// Array-based binary min-heap keyed by number, payload = node id.
// Lazy-deletion friendly: Dijkstra keeps bestDist[] and skips stale pops.
export class MinHeap {
  private keys: Float64Array
  private vals: Int32Array
  private n = 0

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity)
    this.vals = new Int32Array(capacity)
  }

  get size(): number { return this.n }

  /** Smallest entry without removing it. */
  peek(): [number, number] | null {
    return this.n === 0 ? null : [this.keys[0], this.vals[0]]
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2)
    k.set(this.keys)
    const v = new Int32Array(this.vals.length * 2)
    v.set(this.vals)
    this.keys = k; this.vals = v
  }

  push(key: number, val: number): void {
    if (this.n === this.keys.length) this.grow()
    let i = this.n++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= key) break
      this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p]
      i = p
    }
    this.keys[i] = key; this.vals[i] = val
  }

  pop(): [number, number] | null {
    if (this.n === 0) return null
    const topKey = this.keys[0], topVal = this.vals[0]
    this.n--
    if (this.n > 0) {
      const k = this.keys[this.n], v = this.vals[this.n]
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let s = i, sk = k
        if (l < this.n && this.keys[l] < sk) { s = l; sk = this.keys[l] }
        if (r < this.n && this.keys[r] < sk) { s = r; sk = this.keys[r] }
        if (s === i) break
        this.keys[i] = this.keys[s]; this.vals[i] = this.vals[s]
        i = s
      }
      this.keys[i] = k; this.vals[i] = v
    }
    return [topKey, topVal]
  }

  clear(): void { this.n = 0 }
}
