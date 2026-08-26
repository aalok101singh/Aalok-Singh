import { useEffect, useState } from 'react'

const SHORTCUTS: [string, string][] = [
  ['Space', 'pause / resume'],
  ['1 / 2 / 3', 'speed 1× / 2× / 5×'],
  ['E', 'inject DELTA emergency'],
  ['D', 'inject ECHO emergency'],
  ['M', 'toggle AUTO / MANUAL dispatch'],
  ['F', 'follow-cam'],
  ['W', 'wavefront visualizer'],
  ['+ / -', 'zoom'],
  ['?', 'this overlay'],
]

export default function ShortcutsModal(): JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = (): void => setOpen((o) => !o)
    window.addEventListener('caregrid:shortcuts', on)
    return () => window.removeEventListener('caregrid:shortcuts', on)
  }, [])
  if (!open) return <></>
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink/40" onClick={() => setOpen(false)}>
      <div className="w-80 rounded-card border border-border bg-surface p-4 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 font-display text-sm font-bold">Keyboard shortcuts</div>
        <table className="w-full text-xs">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td className="py-0.5 pr-3"><kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono">{k}</kbd></td>
                <td className="text-muted">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
