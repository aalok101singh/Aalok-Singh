// Single source of numeric constants — Build Bible §6.1. No magic numbers elsewhere.
export const CONST = {
  SLA_S: { ECHO: 480, DELTA: 900, CHARLIE: 1800, BRAVO: 3600, ALPHA: 7200 },
  ON_SCENE_S: 600,
  HANDOVER_SERVICE_S: 900,
  RESTOCK_PERIOD_S: 1800,
  BED_OCCUPY_S: 28800,
  SPEED_KMH: [60, 40, 25],
  WEATHER_MAX_MULT: 1.5,
  SEVERITY_RANK: { ECHO: 0, DELTA: 1, CHARLIE: 2, BRAVO: 3, ALPHA: 4 } as Record<string, number>,
  BATCH_MAX: 5,
  CONFIRM_ESCALATE: 0.8,
  FLEET: { ALS: 8, BLS: 16 },
  DRUG_FOR: {
    CARDIOLOGY: 'Streptokinase', GENERAL: 'Paracetamol', OBSTETRIC: 'Atropine',
    PEDIATRIC: 'ORS', SURGERY: 'Atropine', TRAUMA: 'Atropine',
  } as Record<string, string>,
  TICK_S: 1,
  STATE_HZ: 10,
  // sim helpers (derived, still centralized)
  ARRIVALS_MEAN_S: 90,
  INFLUX_MULT: 2.2,
  DEDUPE_WINDOW_S: 120,
  CATCHUP_CAP_S: 30,
} as const
