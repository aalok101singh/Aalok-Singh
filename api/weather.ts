// D6 v1.1 — Vercel serverless: Open-Meteo proxy with 15-min server-side cache.
// No core engine logic lives here (organizer compliance).
type VercelResponse = {
  status(code: number): { json(body: unknown): void }
  setHeader(k: string, v: string): void
}
type VercelRequest = { method?: string }

let cache: { at: number; body: string } | null = null
const TTL_MS = 15 * 60 * 1000

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=60')
  if (cache && Date.now() - cache.at < TTL_MS) {
    res.status(200)
    res.setHeader('X-Cache', 'HIT')
    res.end(cache.body)
    return
  }
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=25.05&longitude=76.675&current=precipitation'
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 4000)
    const r = await fetch(url, { signal: ac.signal })
    clearTimeout(timer)
    if (!r.ok) throw new Error(`open-meteo ${r.status}`)
    const j = (await r.json()) as { current?: { precipitation?: number } }
    const body = JSON.stringify({ precipMm: j.current?.precipitation ?? 0, source: 'serverless' })
    cache = { at: Date.now(), body }
    res.status(200)
    res.setHeader('X-Cache', 'MISS')
    res.end(body)
  } catch {
    // client falls back to direct Open-Meteo, then synthetic driver (D6 chain)
    res.status(503).json({ error: 'upstream unavailable' }) as unknown as void
  }
}
