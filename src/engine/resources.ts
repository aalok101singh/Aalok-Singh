// Fleet states, beds, doctors + duty windows, medicine FEFO (§6.3 step 2, §8).
import { CONST } from './const'
import type { Facility, Specialty } from './types'

export function facilityEligible(f: Facility, need: Specialty, clockS: number): { ok: boolean; reject?: 'NO_SPECIALTY' | 'NO_BEDS' | 'NO_MEDS' } {
  if (!f.specs.includes(need)) return { ok: false, reject: 'NO_SPECIALTY' }
  if (!doctorOnDuty(f, need, clockS)) return { ok: false, reject: 'NO_SPECIALTY' }
  if (f.bedsFree <= 0) return { ok: false, reject: 'NO_BEDS' }
  if (!medsCover(f, need)) return { ok: false, reject: 'NO_MEDS' }
  return { ok: true }
}

export function doctorOnDuty(f: Facility, spec: Specialty, clockS: number): boolean {
  return f.doctors.some((d) => d.spec === spec && d.onDutyUntil > clockS)
}

export function drugFor(need: Specialty): string {
  return CONST.DRUG_FOR[need] ?? 'Paracetamol'
}

export function medsCover(f: Facility, need: Specialty): boolean {
  const drug = drugFor(need)
  return f.meds.some((m) => m.drug === drug && m.qty > 0 && m.expiresAt > 0)
}

/** FEFO reserve: decrement first-expiring batch with stock. Returns doses reserved (may be < requested). */
export function dispenseFEFO(f: Facility, need: Specialty, doses = 1): number {
  const drug = drugFor(need)
  let remaining = doses
  const batches = f.meds.filter((m) => m.drug === drug).sort((a, b) => a.expiresAt - b.expiresAt)
  for (const b of batches) {
    if (remaining === 0) break
    const take = Math.min(b.qty, remaining)
    if (take > 0) { b.qty -= take; remaining -= take }
  }
  return doses - remaining
}

export function restockFacility(f: Facility, rng: () => number): void {
  for (const m of f.meds) m.qty += 2 + Math.floor(rng() * 6)
}
