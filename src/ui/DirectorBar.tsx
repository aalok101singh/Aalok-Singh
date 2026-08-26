import { actions } from '../state/store'

export default function DirectorBar(): JSX.Element {
  const run = (script: 'MOCK' | 'MCI' | 'DISASTER'): void => {
    actions.start()
    actions.director(script)
  }
  return (
    <div className="flex h-11 items-center gap-2 border-b border-border bg-surface px-4">
      <span className="text-xs text-muted">Director:</span>
      <button className="rounded-control bg-primary-soft px-3 py-1 text-xs font-medium text-primary hover:opacity-80" onClick={() => run('MOCK')}>
        ▶ Official Mock
      </button>
      <button className="rounded-control bg-warn-soft px-3 py-1 text-xs font-medium text-warn hover:opacity-80" onClick={() => run('MCI')}>
        ▶ Mass Casualty
      </button>
      <button className="rounded-control bg-danger-soft px-3 py-1 text-xs font-medium text-danger hover:opacity-80" onClick={() => run('DISASTER')}>
        ▶ Monsoon Disaster
      </button>
      <div className="ml-auto flex items-center gap-1.5" aria-hidden>
        {['▲', '●', '■', '◆', '○'].map((g) => (
          <span key={g} className="font-mono text-xs text-muted">{g}</span>
        ))}
      </div>
    </div>
  )
}
