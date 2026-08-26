import { useEffect, useRef, useState } from 'react'
import { getGeometry, getSnapshot, onWavefront } from '../state/store'

// §10.3 Canvas2D map: LOD0–2, pan/zoom, full-route sortie animation, capacity rings, closures, wavefront.
const URGENCY_COLOR: Record<string, string> = {
  ECHO: '#DC2626', DELTA: '#EA580C', CHARLIE: '#D97706', BRAVO: '#0284C7', ALPHA: '#64748B',
}
// map-like palette: majors warm tan with white casing, minors soft gray
const ROAD_STYLE: { color: string; casing: boolean }[] = [
  { color: '#C4B291', casing: true },   // cls 0 major highway
  { color: '#D2C9B6', casing: true },   // cls 1 district road
  { color: '#DCD8CE', casing: false },  // cls 2 village road
]
const ROAD_WIDTH: number[][] = [
  [2.5, 2, 1.2],  // lod0 (zoomed out)
  [3.5, 2.5, 1.6],// lod1
  [5, 3.5, 2],    // lod2 (zoomed in)
]

interface View { cx: number; cy: number; scale: number } // center lat/lng; scale = screen px per meter

export default function MapCanvas(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ cx: 76.675, cy: 25.05, scale: 0.01 })
  const fittedRef = useRef(false)
  const followRef = useRef(false)
  const followTargetRef = useRef<number | null>(null) // emg id
  const followLastRef = useRef<{ la: number; lo: number } | null>(null)
  const wavefrontRef = useRef<{ settled: Uint32Array; frontier: Uint32Array } | null>(null)
  const [zoomLabel, setZoomLabel] = useState(0.01)
  const [expandedN, setExpandedN] = useState(0)
  const [followOn, setFollowOn] = useState(false)

  useEffect(() => {
    const unsub = onWavefront((settled, frontier) => {
      wavefrontRef.current = { settled, frontier }
      setExpandedN(settled.length + frontier.length)
    })
    return unsub
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx2d = canvas.getContext('2d')!
    let raf = 0
    let dashOffset = 0

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    // ---- interaction ----
    let dragging = false
    let lastX = 0, lastY = 0
    const onDown = (e: PointerEvent): void => { dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return
      const v = viewRef.current
      v.cx -= (e.clientX - lastX) / v.scale / 102000
      v.cy += (e.clientY - lastY) / v.scale / 111320
      lastX = e.clientX; lastY = e.clientY
    }
    const onUp = (): void => { dragging = false }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const v = viewRef.current
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const loBefore = v.cx + (mx - rect.width / 2) / (v.scale * 102000)
      const laBefore = v.cy - (my - rect.height / 2) / (v.scale * 111320)
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
      v.scale = Math.min(400, Math.max(0.004, v.scale * f))
      const loAfter = v.cx + (mx - rect.width / 2) / (v.scale * 102000)
      const laAfter = v.cy - (my - rect.height / 2) / (v.scale * 111320)
      v.cx += loBefore - loAfter
      v.cy += laBefore - laAfter
      setZoomLabel(v.scale)
    }
    const onDbl = (): void => {
      const v = viewRef.current
      v.scale = Math.min(400, v.scale * 1.8)
      setZoomLabel(v.scale)
    }
    const onZoomKey = (ev: Event): void => {
      const v = viewRef.current
      const f = (ev as CustomEvent<number>).detail ?? 1.2
      v.scale = Math.min(400, Math.max(0.004, v.scale * f))
      setZoomLabel(v.scale)
    }
    // follow a specific event card (detail = emg id) or toggle newest-hot (no detail)
    const onFollow = (ev: Event): void => {
      const id = (ev as CustomEvent<number | undefined>).detail
      followTargetRef.current = id ?? null
      followRef.current = true
      setFollowOn(true)
    }
    canvas.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDbl)
    window.addEventListener('caregrid:zoom', onZoomKey)
    window.addEventListener('caregrid:follow', onFollow)

    const toScreen = (v: View, la: number, lo: number, wpx: number, hpx: number): [number, number] => {
      const x = (lo - v.cx) * v.scale * 102000 + wpx / 2
      const y = (v.cy - la) * v.scale * 111320 + hpx / 2
      return [x, y]
    }

    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      const geo = getGeometry()
      const snap = getSnapshot()
      const wpx = canvas.clientWidth, hpx = canvas.clientHeight
      ctx2d.fillStyle = '#F5F4EF'
      ctx2d.fillRect(0, 0, wpx, hpx)
      if (!geo) return
      const v = viewRef.current

      // first-geometry fit: center + scale the district into view (once)
      if (!fittedRef.current) {
        fittedRef.current = true
        const [la0, lo0, la1, lo1] = geo.bbox
        v.cx = (lo0 + lo1) / 2
        v.cy = (la0 + la1) / 2
        const fit = Math.min(wpx / Math.max(1, (lo1 - lo0) * 102000), hpx / Math.max(1, (la1 - la0) * 111320))
        v.scale = Math.max(0.004, fit * 0.95)
        setZoomLabel(v.scale)
      }

      // camera can never leave the district (vanish-proof)
      const [la0, lo0, la1, lo1] = geo.bbox
      const mLa = (la1 - la0) * 0.3, mLo = (lo1 - lo0) * 0.3
      v.cy = Math.min(la1 + mLa, Math.max(la0 - mLa, v.cy))
      v.cx = Math.min(lo1 + mLo, Math.max(lo0 - mLo, v.cx))

      // follow-cam: ease toward the targeted event's ambulance (or scene)
      if (followRef.current) {
        let target: { la: number; lo: number } | null = null
        const tid = followTargetRef.current
        if (tid != null) {
          const emg = snap.emgs.find((e) => e.id === tid)
          if (emg) {
            const amb = snap.ambs.find((a) => a.mission === emg.missionId)
            if (amb && (amb.state === 'TO_SCENE' || amb.state === 'TO_FACILITY')) {
              target = {
                la: geo.lat[amb.from] + (geo.lat[amb.to] - geo.lat[amb.from]) * amb.t01,
                lo: geo.lng[amb.from] + (geo.lng[amb.to] - geo.lng[amb.from]) * amb.t01,
              }
            } else {
              target = { la: geo.lat[emg.villageNode], lo: geo.lng[emg.villageNode] }
            }
            followLastRef.current = target
          } else if (followLastRef.current) {
            target = followLastRef.current // mission ended; hold last known position
          }
        } else {
          const hot = [...snap.emgs].reverse().find((e) => e.urgency === 'ECHO' || e.urgency === 'DELTA')
          if (hot) target = { la: geo.lat[hot.villageNode], lo: geo.lng[hot.villageNode] }
        }
        if (target) {
          v.cx += (target.lo - v.cx) * 0.06
          v.cy += (target.la - v.cy) * 0.06
        }
      }

      const zoom = v.scale
      const lod = zoom < 0.04 ? 0 : zoom < 20 ? 1 : 2
      const minLa = v.cy - hpx / (2 * v.scale * 111320), maxLa = v.cy + hpx / (2 * v.scale * 111320)
      const minLo = v.cx - wpx / (2 * v.scale * 102000), maxLo = v.cx + wpx / (2 * v.scale * 102000)

      // ---- roads: draw minors → majors so hierarchy reads; casing under majors ----
      if (zoom >= 0.04) {
        const closedSet = new Set(snap.closedEdges)
        const hasClosures = closedSet.size > 0
        const off = geo.adjOff, adjDst = geo.adjDst
        const N = geo.lat.length
        ctx2d.lineCap = 'round'
        ctx2d.lineJoin = 'round'

        const roadPass = (b: number, width: number, color: string): number[] => {
          const ticks: number[] = []
          ctx2d.lineWidth = width
          ctx2d.strokeStyle = color
          ctx2d.beginPath()
          for (let u = 0; u < N; u++) {
            const laU = geo.lat[u], loU = geo.lng[u]
            if (laU < minLa || laU > maxLa || loU < minLo || loU > maxLo) continue
            for (let e = off[u]; e < off[u + 1]; e++) {
              const vv = adjDst[e]
              if (vv <= u) continue
              const isClosed = hasClosures && closedSet.has(e)
              if (b === 3 ? !isClosed : isClosed || geo.adjCls[e] !== b) continue
              const laV = geo.lat[vv], loV = geo.lng[vv]
              if (laV < minLa || laV > maxLa || loV < minLo || loV > maxLo) continue
              const [x0, y0] = toScreen(v, laU, loU, wpx, hpx)
              const [x1, y1] = toScreen(v, laV, loV, wpx, hpx)
              ctx2d.moveTo(x0, y0)
              ctx2d.lineTo(x1, y1)
              if (b === 3) ticks.push((x0 + x1) / 2, (y0 + y1) / 2)
            }
          }
          ctx2d.stroke()
          return ticks
        }

        const widths = ROAD_WIDTH[lod]
        for (const b of [2, 1, 0]) {
          const st = ROAD_STYLE[b]
          const w = widths[b]
          if (st.casing) roadPass(b, w + 2.5, 'rgba(255,255,255,0.95)')
          roadPass(b, w, st.color)
        }
        if (hasClosures) {
          const ticks = roadPass(3, widths[1] + 1, '#DC2626')
          for (let i = 0; i < ticks.length; i += 2) {
            const mx = ticks[i], my = ticks[i + 1]
            ctx2d.beginPath()
            ctx2d.moveTo(mx - 3, my - 3); ctx2d.lineTo(mx + 3, my + 3)
            ctx2d.stroke()
          }
        }
      }

      // ---- wavefront overlay ----
      const wf = wavefrontRef.current
      if (wf && getSnapshot().wavefrontOn) {
        ctx2d.fillStyle = 'rgba(79,70,229,0.16)'
        for (let i = 0; i < wf.settled.length; i++) {
          const nd = wf.settled[i]
          const [x, y] = toScreen(v, geo.lat[nd], geo.lng[nd], wpx, hpx)
          ctx2d.fillRect(x - 1.5, y - 1.5, 3, 3)
        }
        ctx2d.fillStyle = '#4F46E5'
        for (let i = 0; i < wf.frontier.length; i++) {
          const nd = wf.frontier[i]
          const [x, y] = toScreen(v, geo.lat[nd], geo.lng[nd], wpx, hpx)
          ctx2d.fillRect(x - 2, y - 2, 4, 4)
        }
      }

      // ---- active mission routes: FULL path, white underlay + animated indigo dash ----
      dashOffset = (dashOffset - 0.6) % 16
      const drawRoutes = (width: number, color: string, dash: number[]): void => {
        ctx2d.lineWidth = width
        ctx2d.strokeStyle = color
        ctx2d.setLineDash(dash)
        ctx2d.lineDashOffset = dashOffset
        ctx2d.lineCap = 'round'
        ctx2d.lineJoin = 'round'
        for (const a of snap.ambs) {
          if (a.state !== 'TO_SCENE' && a.state !== 'TO_FACILITY') continue
          if (!a.route || a.route.length === 0) continue
          ctx2d.beginPath()
          const hx = geo.lng[a.from] + (geo.lng[a.to] - geo.lng[a.from]) * a.t01
          const hy = geo.lat[a.from] + (geo.lat[a.to] - geo.lat[a.from]) * a.t01
          const [sx, sy] = toScreen(v, hy, hx, wpx, hpx)
          ctx2d.moveTo(sx, sy)
          for (let i = 1; i < a.route.length; i++) {
            const nd = a.route[i]
            const [x, y] = toScreen(v, geo.lat[nd], geo.lng[nd], wpx, hpx)
            ctx2d.lineTo(x, y)
          }
          ctx2d.stroke()
        }
        ctx2d.setLineDash([])
      }
      drawRoutes(7, 'rgba(255,255,255,0.9)', [])
      drawRoutes(3.5, '#4F46E5', [10, 6])

      // ---- emergency scenes: pulsing urgency ring + white patient disc + person glyph ----
      const pulse = 13 + 3 * Math.sin(performance.now() / 180)
      const ringCandidates = snap.emgs
        .filter((emg) => emg.status !== 'DELIVERED' && emg.status !== 'UNREACHABLE')
        .sort((a, b) => {
          const da = Math.hypot(geo.lat[a.villageNode] - v.cy, geo.lng[a.villageNode] - v.cx)
          const db = Math.hypot(geo.lat[b.villageNode] - v.cy, geo.lng[b.villageNode] - v.cx)
          return da - db
        })
        .slice(0, 200)
      for (const emg of ringCandidates) {
        const [x, y] = toScreen(v, geo.lat[emg.villageNode], geo.lng[emg.villageNode], wpx, hpx)
        const col = URGENCY_COLOR[emg.urgency] ?? '#DC2626'
        ctx2d.strokeStyle = col
        ctx2d.lineWidth = 2.5
        ctx2d.globalAlpha = 0.75
        ctx2d.beginPath()
        ctx2d.arc(x, y, pulse + 8, 0, Math.PI * 2)
        ctx2d.stroke()
        ctx2d.globalAlpha = 1
        ctx2d.fillStyle = '#FFFFFF'
        ctx2d.beginPath(); ctx2d.arc(x, y, 9, 0, Math.PI * 2); ctx2d.fill()
        ctx2d.stroke()
        drawPerson(ctx2d, x, y, 5, col)
        if (followTargetRef.current === emg.id && followRef.current) {
          ctx2d.strokeStyle = '#4F46E5'
          ctx2d.lineWidth = 2
          ctx2d.beginPath(); ctx2d.arc(x, y, pulse + 13, 0, Math.PI * 2); ctx2d.stroke()
        }
      }

      // ---- facilities: white shield + red medical cross + tier-colored breathing ring ----
      for (const f of geo.facilities) {
        const [x, y] = toScreen(v, geo.lat[f.node], geo.lng[f.node], wpx, hpx)
        const fd = snap.facilities.find((ff) => ff.id === f.id)
        const bedsPct = fd && fd.bedsTotal > 0 ? fd.bedsFree / fd.bedsTotal : 1
        const ringColor = bedsPct > 0.5 ? '#059669' : bedsPct > 0.2 ? '#D97706' : '#DC2626'
        ctx2d.strokeStyle = ringColor
        ctx2d.lineWidth = 2.5
        ctx2d.globalAlpha = 0.9
        ctx2d.beginPath(); ctx2d.arc(x, y, 14 + Math.sin(performance.now() / 600 + f.id) * 1.5, 0, Math.PI * 2); ctx2d.stroke()
        ctx2d.globalAlpha = 1
        ctx2d.fillStyle = '#FFFFFF'
        roundRect(ctx2d, x - 8, y - 8, 16, 16, 4)
        ctx2d.fill()
        ctx2d.lineWidth = 2
        ctx2d.strokeStyle = '#B9B3A6'
        ctx2d.stroke()
        ctx2d.fillStyle = '#DC2626'
        ctx2d.fillRect(x - 1.75, y - 5.25, 3.5, 10.5)
        ctx2d.fillRect(x - 5.25, y - 1.75, 10.5, 3.5)
        if (lod >= 1) {
          ctx2d.fillStyle = '#1C1917'
          ctx2d.font = '600 10px Inter'
          ctx2d.fillText(f.name, x + 12, y + 3)
        }
      }

      // ---- villages ----
      for (const vil of geo.villages) {
        const [x, y] = toScreen(v, geo.lat[vil.node], geo.lng[vil.node], wpx, hpx)
        ctx2d.fillStyle = lod === 0 ? 'rgba(120,113,108,0.45)' : '#78716C'
        ctx2d.beginPath()
        ctx2d.arc(x, y, Math.max(1.2, Math.min(4, Math.sqrt(vil.pop) / 22)), 0, Math.PI * 2)
        ctx2d.fill()
        if (lod >= 2) {
          ctx2d.fillStyle = '#78716C'
          ctx2d.font = '10px Inter'
          ctx2d.fillText(vil.name, x + 5, y - 4)
        }
      }

      // ---- ambulance glyphs: white body, state stripe, flashing beacon, heading arrow ----
      for (const a of snap.ambs) {
        const la = geo.lat[a.from] + (geo.lat[a.to] - geo.lat[a.from]) * a.t01
        const lo = geo.lng[a.from] + (geo.lng[a.to] - geo.lng[a.from]) * a.t01
        const [x, y] = toScreen(v, la, lo, wpx, hpx)
        const stateColor = a.state === 'AVAILABLE' ? '#059669' : a.state === 'ON_SCENE' || a.state === 'HANDOVER' ? '#D97706' : '#4F46E5'
        const responding = a.state === 'TO_SCENE' || a.state === 'TO_FACILITY'
        // status halo
        ctx2d.strokeStyle = stateColor
        ctx2d.globalAlpha = 0.4
        ctx2d.lineWidth = 2
        ctx2d.beginPath(); ctx2d.arc(x, y, 13, 0, Math.PI * 2); ctx2d.stroke()
        ctx2d.globalAlpha = 1
        // white body + ink outline
        ctx2d.fillStyle = '#FFFFFF'
        roundRect(ctx2d, x - 9, y - 6, 18, 12, 3)
        ctx2d.fill()
        ctx2d.lineWidth = 1.5
        ctx2d.strokeStyle = '#1C1917'
        ctx2d.stroke()
        // state stripe
        ctx2d.fillStyle = stateColor
        ctx2d.fillRect(x - 8, y - 1.5, 16, 3)
        // flashing beacon while responding
        if (responding) {
          const flash = Math.floor(performance.now() / 220) % 2 === 0
          ctx2d.fillStyle = flash ? '#DC2626' : '#0284C7'
          ctx2d.beginPath(); ctx2d.arc(x, y - 8, 2.5, 0, Math.PI * 2); ctx2d.fill()
        }
        // heading arrow
        if (responding) {
          const [fx, fy] = toScreen(v, geo.lat[a.from], geo.lng[a.from], wpx, hpx)
          const [tx, ty] = toScreen(v, geo.lat[a.to], geo.lng[a.to], wpx, hpx)
          let dx = tx - fx, dy = ty - fy
          const len = Math.hypot(dx, dy) || 1
          dx /= len; dy /= len
          ctx2d.fillStyle = stateColor
          ctx2d.beginPath()
          ctx2d.moveTo(x + dx * 14, y + dy * 14)
          ctx2d.lineTo(x + dx * 7 - dy * 4, y + dy * 7 + dx * 4)
          ctx2d.lineTo(x + dx * 7 + dy * 4, y + dy * 7 - dx * 4)
          ctx2d.fill()
        }
        if (zoom >= 0.08) {
          ctx2d.fillStyle = '#1C1917'
          ctx2d.font = '600 10px "JetBrains Mono"'
          ctx2d.fillText(a.callsign, x + 11, y - 9)
        }
      }

      // ---- legend: urgency colors + entity key ----
      ctx2d.fillStyle = '#FFFFFF'
      ctx2d.strokeStyle = '#E7E4DD'
      roundRect(ctx2d, 10, hpx - 60, 236, 50, 6)
      ctx2d.fill(); ctx2d.stroke()
      ctx2d.font = '10px Inter'
      let lx = 18
      for (const [uName, col] of Object.entries(URGENCY_COLOR)) {
        ctx2d.fillStyle = col
        ctx2d.beginPath(); ctx2d.arc(lx, hpx - 44, 3, 0, Math.PI * 2); ctx2d.fill()
        ctx2d.fillStyle = '#78716C'
        ctx2d.fillText(uName, lx + 5, hpx - 41)
        lx += 45
      }
      const y2 = hpx - 19
      lx = 18
      drawPerson(ctx2d, lx + 4, y2 - 2, 4.5, '#DC2626')
      ctx2d.fillStyle = '#78716C'; ctx2d.fillText('patient', lx + 12, y2 + 3)
      lx += 62
      ctx2d.fillStyle = '#FFFFFF'; roundRect(ctx2d, lx, y2 - 5, 14, 9, 2); ctx2d.fill()
      ctx2d.strokeStyle = '#1C1917'; ctx2d.lineWidth = 1; ctx2d.stroke()
      ctx2d.fillStyle = '#4F46E5'; ctx2d.fillRect(lx + 2, y2 - 2, 10, 3)
      ctx2d.fillStyle = '#78716C'; ctx2d.fillText('ambulance', lx + 18, y2 + 3)
      lx += 86
      ctx2d.fillStyle = '#FFFFFF'; roundRect(ctx2d, lx, y2 - 6, 12, 12, 2); ctx2d.fill()
      ctx2d.strokeStyle = '#B9B3A6'; ctx2d.lineWidth = 1.5; ctx2d.stroke()
      ctx2d.fillStyle = '#DC2626'
      ctx2d.fillRect(lx + 5, y2 - 3.5, 2, 7); ctx2d.fillRect(lx + 2.5, y2 - 1, 7, 2)
      ctx2d.fillStyle = '#78716C'; ctx2d.fillText('hospital', lx + 16, y2 + 3)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDbl)
      window.removeEventListener('caregrid:zoom', onZoomKey)
      window.removeEventListener('caregrid:follow', onFollow)
    }
  }, [])

  const toggleFollow = (): void => {
    followRef.current = !followRef.current
    if (!followRef.current) followTargetRef.current = null
    setFollowOn(followRef.current)
  }

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full cursor-grab active:cursor-grabbing" aria-label="district map" />
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <button className={`rounded-control border px-2 py-1 text-xs shadow-card ${followOn ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface'}`} onClick={toggleFollow}>
          follow-cam {followOn ? 'on' : 'off'} — click a request card to track it
        </button>
        <div className="rounded-control border border-border bg-surface px-2 py-1 font-mono text-xs tnum shadow-card">
          zoom ×{zoomLabel < 1 ? zoomLabel.toFixed(2) : Math.round(zoomLabel)}
        </div>
        {getSnapshot().wavefrontOn && (
          <div className="rounded-control border border-primary bg-primary-soft px-2 py-1 font-mono text-xs text-primary tnum">expanded: {expandedN}</div>
        )}
      </div>
    </div>
  )
}

/** Tiny person glyph: head + torso + legs — reads as "patient" at any size. */
function drawPerson(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  c.fillStyle = col
  c.beginPath(); c.arc(x, y - r * 0.5, r * 0.36, 0, Math.PI * 2); c.fill()
  c.strokeStyle = col
  c.lineWidth = Math.max(1.4, r * 0.42)
  c.lineCap = 'round'
  c.beginPath(); c.moveTo(x, y - r * 0.08); c.lineTo(x, y + r * 0.28); c.stroke()
  c.beginPath(); c.moveTo(x, y + r * 0.28); c.lineTo(x - r * 0.32, y + r * 0.75); c.stroke()
  c.beginPath(); c.moveTo(x, y + r * 0.28); c.lineTo(x + r * 0.32, y + r * 0.75); c.stroke()
  c.lineCap = 'butt'
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}
