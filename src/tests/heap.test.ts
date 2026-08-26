import { describe, expect, it } from 'vitest'
import { MinHeap } from '../engine/heap'

describe('MinHeap', () => {
  it('pops in ascending key order', () => {
    const h = new MinHeap(8)
    const keys = [5, 3, 9, 1, 7, 2]
    keys.forEach((k, i) => h.push(k, i))
    const out: number[] = []
    while (h.size > 0) out.push(h.pop()![0])
    expect(out).toEqual([...keys].sort((a, b) => a - b))
  })

  it('carries payloads', () => {
    const h = new MinHeap()
    h.push(10, 42)
    h.push(4, 99)
    expect(h.pop()).toEqual([4, 99])
    expect(h.pop()).toEqual([10, 42])
    expect(h.pop()).toBeNull()
  })

  it('grows beyond initial capacity', () => {
    const h = new MinHeap(2)
    for (let i = 100; i >= 0; i--) h.push(i, i)
    expect(h.size).toBe(101)
    expect(h.pop()![0]).toBe(0)
    expect(h.peek()![0]).toBe(1)
  })
})
