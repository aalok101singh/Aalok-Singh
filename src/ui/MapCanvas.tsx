import { useEffect, useRef, useState } from 'react'
import { getGeometry, getSnapshot, onWavefront } from '../state/store'

// §10.3 Canvas2D map: LOD0–2, pan/zoom, sortie animation, capacity rings, closures, wavefront.
const URGENCY_COLOR: Record<string, string> = {
  ECHO: '#DC2626', DELTA: '#EA580C', CHARLIE: '#D97706', BRAVO: '#0284C7', ALPHA: '#64748B',
}
const ROAD_COLOR = ['#B8B4AA', '#D6D3CC', '#E3E1DB']

interface View { cx: number; cy: number; scale: number } // center in world px; scale = screen px per world unit

export default function MapCanvas(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ cx: 76.675, cy: 25.05, scale: 0.01 })
  const fittedRef = useRef(false)
  const followRef = useRef(false)
  const wavefrontRef = useRef<{ settled: Uint32Array; frontier: Uint32Array } | null>(null)
  const [zoomLabel, setZoomLabel] = useState(0.01)
  const [expandedN, setExpandedN] = useState(0)

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
    const onDown = (e: PointerEvent): void => { dragging = true; lastX = e.clientX; lastY = e.clientY; followRef.current = false }
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return
      const v = viewRef.current
      v.cx -= (e.clientX - lastX) / v.scale
      v.cy -= (e.clientY - lastY) / v.scale
      lastX = e.clientX; lastY = e.clientY
    }
    const onUp = (): void => { dragging = false }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const v = viewRef.current
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      // world coords under cursor before zoom
      const loBefore = v.cx + (mx - rect.width / 2) / (v.scale * 102000)
      const laBefore = v.cy - (my - rect.height / 2) / (v.scale * 111320)
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
      v.scale = Math.min(400, Math.max(0.004, v.scale * f))
      // world coords under cursor after zoom; shift center to keep cursor anchored
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
    canvas.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDbl)
    window.addEventListener('caregrid:zoom', onZoomKey)

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

      // first-geometry fit: center + scale the district bbox into view (once)
      if (!fittedRef.current) {
        fittedRef.current = true
        const [la0, lo0, la1, lo1] = geo.bbox
        v.cx = (lo0 + lo1) / 2
        v.cy = (la0 + la1) / 2
        const fit = Math.min(wpx / Math.max(1, (lo1 - lo0) * 102000), hpx / Math.max(1, (la1 - la0) * 111320))
        v.scale = Math.max(0.004, fit * 0.95)
        setZoomLabel(v.scale)
      }

      // district bbox outline
      const [bx0, by0] = toScreen(v, geo.bbox[0], geo.bbox[1], wpx, hpx)
      const [bx1, by1] = toScreen(v, geo.bbox[2], geo.bbox[3], wpx, hpx)
      ctx2d.strokeStyle = '#DDD9CF'
      ctx2d.strokeRect(bx0, by0, bx1 - bx0, by1 - by0)

      // follow-cam: ease toward newest ECHO/DELTA scene
      if (followRef.current) {
        const hot = [...snap.emgs].reverse().find((e) => e.urgency === 'ECHO' || e.urgency === 'DELTA')
        if (hot) {
          const targetLa = geo.lat[hot.villageNode], targetLo = geo.lng[hot.villageNode]
          v.cx += (targetLo - v.cx) * 0.06
          v.cy += (targetLa - v.cy) * 0.06
        }
      }

      const zoom = v.scale
      // viewport bounds in world coords for culling
      const minLa = v.cy - hpx / (2 * v.scale * 111320), maxLa = v.cy + hpx / (2 * v.scale * 111320)
      const minLo = v.cx - wpx / (2 * v.scale * 102000), maxLo = v.cx + wpx / (2 * v.scale * 102000)

      // ---- edges with LOD ----
      const lod = zoom < 20 ? 0 : zoom < 200 ? 1 : 2
      const closedSet = new Set(snap.closedEdges)
      const off = geo.adjOff
      const adjDst = geo.adjDst
      const lw = lod === 2 ? 1.5 : 1
      ctx2d.lineWidth = lw

      const N = geo.lat.length
      for (let u = 0; u < N; u++) {
        const laU = geo.lat[u], loU = geo.lng[u]
        if (laU < minLa || laU > maxLa || loU < minLo || loU > maxLo) continue
        for (let e = off[u]; e < off[u + 1]; e++) {
          const vv = adjDst[e]
          if (vv <= u) continue // draw each undirected edge once
          const laV = geo.lat[vv], loV = geo.lng[vv]
          if (laV < minLa || laV > maxLa || loV < minLo || loV > maxLo) continue
          const cls = geo.adjCls[e]
          if (lod === 0 && cls !== 0) continue // skeleton only
          const [x0, y0] = toScreen(v, laU, loU, wpx, hpx)
          const [x1, y1] = toScreen(v, laV, loV, wpx, hpx)
          const closedEdge = closedSet.has(e)
          ctx2d.strokeStyle = closedEdge ? '#DC2626' : ROAD_COLOR[cls] ?? '#D6D3CC'
          ctx2d.beginPath()
          ctx2d.moveTo(x0, y0)
          ctx2d.lineTo(x1, y1)
          ctx2d.stroke()
          if (closedEdge) {
            // red hatch tick at midpoint
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
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

      // ---- active mission routes (animated dash) ----
      dashOffset = (dashOffset - 0.6) % 16
      ctx2d.lineWidth = 3
      ctx2d.setLineDash([10, 6])
      ctx2d.lineDashOffset = dashOffset
      ctx2d.strokeStyle = '#4F46E5'
      for (const a of snap.ambs) {
        if (a.state !== 'TO_SCENE' && a.state !== 'TO_FACILITY') continue
        const [x0, y0] = toScreen(v, geo.lat[a.from], geo.lng[a.from], wpx, hpx)
        const [x1, y1] = toScreen(v, geo.lat[a.to], geo.lng[a.to], wpx, hpx)
        ctx2d.beginPath()
        ctx2d.moveTo(x0, y0)
        ctx2d.lineTo(x1, y1)
        ctx2d.stroke()
      }
      ctx2d.setLineDash([])

      // ---- emergency scene rings (pulsing, urgency color + shape; §10.2 v1.1: capped to 200 nearest viewport) ----
      const pulse = 4 + 2.5 * Math.sin(performance.now() / 180)
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
        ctx2d.strokeStyle = URGENCY_COLOR[emg.urgency] ?? '#DC2626'
        ctx2d.lineWidth = 2
        ctx2d.beginPath()
        ctx2d.arc(x, y, pulse + 4, 0, Math.PI * 2)
        ctx2d.stroke()
        drawGlyph(ctx2d, emg.urgency, x, y, 4)
      }

      // ---- facilities: badges + capacity rings ----
      for (const f of geo.facilities) {
        const [x, y] = toScreen(v, geo.lat[f.node], geo.lng[f.node], wpx, hpx)
        const fd = snap.facilities.find((ff) => ff.id === f.id)
        const bedsPct = fd && fd.bedsTotal > 0 ? fd.bedsFree / fd.bedsTotal : 1
        const ringColor = bedsPct > 0.5 ? '#059669' : bedsPct > 0.2 ? '#D97706' : '#DC2626'
        ctx2d.strokeStyle = ringColor
        ctx2d.lineWidth = 1.5
        ctx2d.beginPath(); ctx2d.arc(x, y, 7 + Math.sin(performance.now() / 600 + f.id) * 1.2, 0, Math.PI * 2); ctx2d.stroke()
        ctx2d.fillStyle = tierColor(f.tier)
        ctx2d.fillRect(x - 3, y - 3, 6, 6)
        if (lod >= 1) {
          ctx2d.fillStyle = '#1C1917'
          ctx2d.font = '10px Inter'
          ctx2d.fillText(f.name, x + 9, y + 3)
        }
      }

      // ---- villages ----
      for (const vil of geo.villages) {
        const [x, y] = toScreen(v, geo.lat[vil.node], geo.lng[vil.node], wpx, hpx)
        ctx2d.fillStyle = '#78716C'
        ctx2d.beginPath()
        ctx2d.arc(x, y, Math.max(1.2, Math.min(4, Math.sqrt(vil.pop) / 22)), 0, Math.PI * 2)
        ctx2d.fill()
        if (lod >= 2) {
          ctx2d.fillStyle = '#78716C'
          ctx2d.font = '10px Inter'
          ctx2d.fillText(vil.name, x + 5, y - 4)
        }
      }

      // ---- ambulance glyphs ----
      for (const a of snap.ambs) {
        const la = geo.lat[a.from] + (geo.lat[a.to] - geo.lat[a.from]) * a.t01
        const lo = geo.lng[a.from] + (geo.lng[a.to] - geo.lng[a.from]) * a.t01
        const [x, y] = toScreen(v, la, lo, wpx, hpx)
        const stateColor = a.state === 'AVAILABLE' ? '#059669' : a.state === 'ON_SCENE' || a.state === 'HANDOVER' ? '#D97706' : '#4F46E5'
        // status halo
        ctx2d.strokeStyle = stateColor
        ctx2d.globalAlpha = 0.35
        ctx2d.beginPath(); ctx2d.arc(x, y, 8, 0, Math.PI * 2); ctx2d.stroke()
        ctx2d.globalAlpha = 1
        // rounded rect body
        ctx2d.fillStyle = a.cls === 'ALS' ? '#1C1917' : '#44403C'
        roundRect(ctx2d, x - 5, y - 3.5, 10, 7, 2)
        ctx2d.fill()
        // heading arrow: screen-space direction from→to
        const [fx, fy] = toScreen(v, geo.lat[a.from], geo.lng[a.from], wpx, hpx)
        const [tx, ty] = toScreen(v, geo.lat[a.to], geo.lng[a.to], wpx, hpx)
        let dx = tx - fx, dy = ty - fy
        const len = Math.hypot(dx, dy) || 1
        dx /= len; dy /= len
        ctx2d.fillStyle = stateColor
        ctx2d.beginPath()
        ctx2d.moveTo(x + dx * 8, y + dy * 8)
        ctx2d.lineTo(x + dx * 3 - dy * 2.5, y + dy * 3 + dx * 2.5)
        ctx2d.lineTo(x + dx * 3 + dy * 2.5, y + dy * 3 - dx * 2.5)
        ctx2d.fill()
        if (lod >= 2) {
          ctx2d.fillStyle = '#1C1917'
          ctx2d.font = '600 9px "JetBrains Mono"'
          ctx2d.fillText(a.callsign, x + 8, y - 6)
        }
      }

      // legend chip
      ctx2d.fillStyle = '#FFFFFF'
      ctx2d.strokeStyle = '#E7E4DD'
      roundRect(ctx2d, 10, hpx - 34, 210, 24, 6)
      ctx2d.fill(); ctx2d.stroke()
      ctx2d.font = '10px Inter'
      let lx = 18
      for (const [uName, col] of Object.entries(URGENCY_COLOR)) {
        ctx2d.fillStyle = col
        ctx2d.beginPath(); ctx2d.arc(lx, hpx - 22, 3, 0, Math.PI * 2); ctx2d.fill()
        ctx2d.fillStyle = '#78716C'
        ctx2d.fillText(uName, lx + 5, hpx - 19)
        lx += 42
      }
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
    }
  }, [])

  const toggleFollow = (): void => { followRef.current = !followRef.current }

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full cursor-grab active:cursor-grabbing" aria-label="district map" />
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <button className="rounded-control border border-border bg-surface px-2 py-1 text-xs shadow-card" onClick={toggleFollow}>follow-cam</button>
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

function tierColor(tier: string): string {
  return tier === 'DH' ? '#DC2626' : tier === 'CHC' ? '#D97706' : tier === 'PHC' ? '#0284C7' : '#64748B'
}

const GLYPHS: Record<string, 'triangle' | 'circle' | 'square' | 'diamond'> = {
  ECHO: 'triangle', DELTA: 'circle', CHARLIE: 'square', BRAVO: 'diamond', ALPHA: 'circle',
}

function drawGlyph(c: CanvasRenderingContext2D, urgency: string, x: number, y: number, r: number): void {
  c.fillStyle = URGENCY_COLOR[urgency] ?? '#DC2626'
  c.beginPath()
  switch (GLYPHS[urgency]) {
    case 'triangle':
      c.moveTo(x, y - r); c.lineTo(x + r, y + r); c.lineTo(x - r, y + r); c.closePath(); break
    case 'square':
      c.rect(x - r, y - r, r * 2, r * 2); break
    case 'diamond':
      c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); break
    default:
      c.arc(x, y, r, 0, Math.PI * 2)
  }
  c.fill()
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
