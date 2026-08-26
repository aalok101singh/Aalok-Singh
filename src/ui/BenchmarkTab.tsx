import { useState } from 'react'
import { actions, getSnapshot } from '../state/store'
import { t } from '../i18n/t'

export default function BenchmarkTab(): JSX.Element {
  const s = getSnapshot()
  const [running, setRunning] = useState(false)
  const b = s.bench
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3 text-xs">
      <button
        className="self-start rounded-control bg-primary px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
        disabled={running}
        onClick={() => { setRunning(true); actions.bench(200); setTimeout(() => setRunning(false), 4000) }}
      >
        {t('bench.run', 'Run suite')} (200 random s-t pairs)
      </button>
      {!b ? (
        <div className="text-muted">{running ? 'running chunked suite…' : 'runs on the active world only'}</div>
      ) : (
        <>
          <table className="w-full border-collapse font-mono tnum">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-1 pr-2">algorithm</th><th>mean ms</th><th>p95 ms</th><th>expanded</th><th>relaxed</th><th>heapOps</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.algorithm} className="border-b border-border/60">
                  <td className="py-1 pr-2">{r.algorithm}</td>
                  <td>{r.meanMs}</td><td>{r.p95Ms}</td>
                  <td>{r.meanExpanded.toLocaleString()}</td>
                  <td>{r.meanRelaxed.toLocaleString()}</td>
                  <td>{r.heapOps.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rounded-card border border-border bg-surface p-2.5 leading-relaxed">
            <div>graph: {b.graph.nodes.toLocaleString()} nodes · {b.graph.edges.toLocaleString()} directed edges · {b.graph.components} component(s)</div>
            <div>RAM: {b.graph.ramMB !== null ? `${b.graph.ramMB} MB (JS heap)` : 'n/a in this browser'}</div>
            <div>heap microbench: {b.graph.heapOpsPerSec.toLocaleString()} push+pop ops/sec</div>
            <div className="mt-1 text-muted">Dijkstra O((V+E) log V) · Bidirectional ≈2× practical speedup · A* admissible haversine/60kmh heuristic</div>
          </div>
        </>
      )}
    </div>
  )
}


