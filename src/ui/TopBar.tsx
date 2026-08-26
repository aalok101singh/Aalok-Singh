import { actions, ensureWorker, getSnapshot } from '../state/store'
import { t, getLang, setLang } from '../i18n/t'

function clockStr(clockS: number): string {
  const h = Math.floor(clockS / 3600), m = Math.floor((clockS % 3600) / 60)
  return `${String((8 + h) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export default function TopBar(): JSX.Element {
  const s = getSnapshot()
  const toggleLang = (): void => { setLang(getLang() === 'en' ? 'hi' : 'en'); }
  return (
    <div className="flex h-14 items-center gap-4 border-b border-border bg-surface px-4">
      <div className="font-display text-lg font-bold tracking-tight">CareGrid <span className="text-primary">◆</span></div>
      <div className="text-xs text-muted">{t('app.subtitle')}</div>
      <div className="ml-4 flex items-center gap-3 font-mono text-sm tnum">
        <span>{clockStr(s.clockS)}</span>
        <button
          className="rounded-control border border-border px-2 py-0.5 text-xs hover:bg-bg"
          onClick={() => (s.running ? actions.pause() : actions.start())}
        >
          {s.running ? `⏸ ${t('action.pause')}` : `▶ ${t('action.resume')}`}
        </button>
        {[1, 2, 5].map((m) => (
          <button
            key={m}
            className={`rounded-control border px-1.5 py-0.5 text-xs font-mono ${s.speedMult === m ? 'border-primary bg-primary-soft text-primary' : 'border-border'}`}
            onClick={() => actions.speed(m as 1 | 2 | 5)}
          >
            {m}×
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <ModeToggle />
        <button
          className={`rounded-control border px-2 py-1 text-xs font-medium ${getSnapshot().wavefrontOn ? 'border-primary bg-primary-soft text-primary' : 'border-border'}`}
          onClick={() => actions.wavefront(!getSnapshot().wavefrontOn)}
        >
          wavefront
        </button>
        <button className="rounded-control border border-border px-2 py-1 text-xs" onClick={toggleLang}>
          {getLang() === 'en' ? 'EN/हिंदी' : 'हिंदी/EN'}
        </button>
        <button
          className="rounded-control border border-border px-2 py-1 text-xs"
          onClick={() => window.dispatchEvent(new CustomEvent('caregrid:shortcuts'))}
        >
          ?
        </button>
      </div>
    </div>
  )
}

function ModeToggle(): JSX.Element {
  const s = getSnapshot()
  return (
    <button
      className={`rounded-control border px-2 py-1 text-xs font-semibold ${s.manual ? 'border-warn bg-warn-soft text-warn' : 'border-ok bg-ok-soft text-ok'}`}
      onClick={() => { actions.mode(!s.manual); }}
    >
      {s.manual ? t('mode.manual') : t('mode.auto')}
    </button>
  )
}

export function bootWorkerOnce(): void { ensureWorker() }
