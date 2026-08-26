// quick FULL-gen memory probe (dev only)
globalThis.performance ??= { now: () => Number(process.hrtime.bigint() / 1000000n) }
const t0 = performance.now()
const mod = await import('../src/engine/world.ts')
const w = mod.proceduralWorld(42, 'FULL')
console.log('nodes', w.nodeCount, 'edges', w.adjDst.length, 'villages', w.villages.length, 'facs', w.facilities.length)
console.log('ms', Math.round(performance.now() - t0), 'heapMB', Math.round(process.memoryUsage().heapUsed / 1048576))
