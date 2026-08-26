// Weather: Open-Meteo live rainfall -> road-speed multipliers; 15-min cache; synthetic fallback (D6, §8).
import { mulberry32 } from './rng'

export interface WeatherState {
  precipMm: number
  mult: number
  zones: { minLat: number; minLng: number; maxLat: number; maxLng: number }[]
  source: 'open-meteo' | 'synthetic'
  fetchedAtS: number
}

const CACHE_S = 15 * 60
let cache: WeatherState | null = null

export function weatherMultFor(nodeMultArr: Float32Array | undefined): number {
  void nodeMultArr
  return 1
}

export function precipToMult(precipMm: number): number {
  return 1 + (Math.min(Math.max(precipMm, 0), 5) / 5) * 0.5 // ×1.0..×1.5
}

/** Build per-node multipliers from zone rectangles + base multiplier inside zones. */
export function applyZones(lat: Float64Array, lng: Float64Array, st: WeatherState): Float32Array {
  const m = new Float32Array(lat.length).fill(1)
  if (st.precipMm <= 1) return m
  for (const z of st.zones) {
    for (let i = 0; i < lat.length; i++) {
      if (lat[i] >= z.minLat && lat[i] <= z.maxLat && lng[i] >= z.minLng && lng[i] <= z.maxLng) {
        m[i] = Math.max(m[i], st.mult)
      }
    }
  }
  return m
}

function seededZones(rng: () => number): WeatherState['zones'] {
  const zones: WeatherState['zones'] = []
  for (let i = 0; i < 3; i++) {
    const h = 0.12 + rng() * 0.15
    const w = 0.18 + rng() * 0.2
    const la = 24.8 + rng() * (25.3 - 24.8 - h)
    const lo = 76.35 + rng() * (77.0 - 76.35 - w)
    zones.push({ minLat: la, minLng: lo, maxLat: la + h, maxLng: lo + w })
  }
  return zones
}

export async function fetchWeather(clockS: number, seed: number, forceSynthetic = false): Promise<WeatherState> {
  if (cache && clockS - cache.fetchedAtS < CACHE_S) return cache
  const zones = seededZones(mulberry32(seed))
  let state: WeatherState
  if (!forceSynthetic) {
    try {
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=25.05&longitude=76.675&current=precipitation')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as { current?: { precipitation?: number } }
      const mm = j.current?.precipitation ?? 0
      state = { precipMm: mm, mult: precipToMult(mm), zones, source: 'open-meteo', fetchedAtS: clockS }
    } catch {
      state = syntheticWeather(clockS, seed, zones)
    }
  } else {
    state = syntheticWeather(clockS, seed, zones)
  }
  cache = state
  return state
}

export function syntheticWeather(clockS: number, seed: number, zones?: WeatherState['zones']): WeatherState {
  const z = zones ?? seededZones(mulberry32(seed))
  // seeded sinusoidal storm cycles: storm every ~2h sim, peak width ~30min
  const phase = Math.sin((clockS / 7200) * Math.PI * 2 + seed)
  const mm = phase > 0.6 ? (phase - 0.6) / 0.4 * 5 : 0
  return { precipMm: mm, mult: precipToMult(mm), zones: z, source: 'synthetic', fetchedAtS: clockS }
}

export function resetWeatherCache(): void {
  cache = null
}
