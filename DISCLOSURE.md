Built with: Vite, React, TypeScript, and Tailwind CSS. One optional Vercel serverless function (`/api/weather.ts` — a weather proxy stub; the simulation itself uses a **synthetic monsoon model** computed in-engine, with no external calls).

**Data — plain and honest:** the road network and villages are **procedurally generated** — a seeded, deterministic lattice modeled on Baran district's geography and settlement density (50,000 junctions · 344,100 road segments · 5,200 villages, identical from the same seed). Village names are inspired by real Baran toponyms; the road data is **not** survey data and no OpenStreetMap extract ships with the app. Clinical parameters (on-scene times, drug stocks, duty windows) are synthetic but structurally faithful.

Weather in the simulation is a synthetic 3-zone monsoon multiplier — no Open-Meteo call is made by the engine.

AI coding assistant used for implementation velocity, as explicitly permitted by organizers. **Core statement:** *All routing, optimization, resource-allocation, triage, and decision logic in `src/engine/` is original work implemented from scratch in TypeScript — no algorithm libraries, no copied routing projects.*
