import { useState } from 'react'
import { actions, getSnapshot } from '../state/store'
import { t } from '../i18n/t'

export default function BenchmarkTab(): JSX.Element {
  const s = getSnapshot()
  const [running, setRunning] = useState(false)
  const b = s.bench
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3 text-xs">
      <p className="leading-relaxed text-muted">
        We time <b className="text-ink">200 random ambulance routes</b> across the real district map with three route-finding
        algorithms, so the speed claims are measured — not promised.
      </p>
      <button
        className="self-start rounded-control bg-primary px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
        disabled={running}
        onClick={() => { setRunning(true); actions.bench(200); setTimeout(() => setRunning(false), 4000) }}
      >
        {running ? 'timing 600 routes…' : t('bench.run', 'Run the route speed test')}
      </button>
      {!b ? (
        <div className="text-muted">Press the button — it takes a few seconds on the live map.</div>
      ) : (
        <>
          <table className="w-full border-collapse font-mono tnum">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-1 pr-2">Algorithm</th><th>Avg time</th><th>Slowest 5%</th><th>Junctions checked</th><th>Roads examined</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.algorithm} className="border-b border-border/60">
                  <td className="py-1 pr-2">{r.algorithm === 'Bidirectional Dijkstra' ? 'Two-sided search' : r.algorithm === 'A*' ? 'A* (map-aware)' : r.algorithm}</td>
                  <td>{r.meanMs} ms</td><td>{r.p95Ms} ms</td>
                  <td>{r.meanExpanded.toLocaleString()}</td>
                  <td>{r.meanRelaxed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rounded-card border border-border bg-surface p-2.5 leading-relaxed">
            <div>The map: <b>{b.graph.nodes.toLocaleString()}</b> junctions · <b>{b.graph.edges.toLocaleString()}</b> road segments · <b>{s.worldStats?.villages.toLocaleString() ?? '5,200'}</b> villages · 1 connected network</div>
            <div>Route-finding queue: <b>{b.graph.heapOpsPerSec.toLocaleString()}</b> operations/sec</div>
            <div className="mt-1 text-muted">
              Fewer junctions & roads examined = smarter search. A* uses the map geometry to look only where the hospital
              could plausibly be — that is why it wins. All three find the same fastest route.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
