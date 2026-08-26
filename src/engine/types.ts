// CareGrid engine types — authoritative per Build Bible §5.
export type NodeId = number
export type Urgency = 'ECHO' | 'DELTA' | 'CHARLIE' | 'BRAVO' | 'ALPHA'
export type Tier = 'HSC' | 'PHC' | 'CHC' | 'DH'
export type Specialty = 'CARDIOLOGY' | 'GENERAL' | 'OBSTETRIC' | 'PEDIATRIC' | 'SURGERY' | 'TRAUMA'
export type AmbClass = 'ALS' | 'BLS'
export type AmbState = 'AVAILABLE' | 'TO_SCENE' | 'ON_SCENE' | 'TO_FACILITY' | 'HANDOVER'
export type CallerType = 'FAMILY' | 'ASHA' | 'PHC_REFERRAL'
export type EmgStatus = 'QUEUED' | 'AWAITING_CONFIRM' | 'ASSIGNED' | 'ON_SCENE' | 'TRANSPORT' | 'DELIVERED' | 'UNREACHABLE'

export interface Doctor { spec: Specialty; onDutyUntil: number }
export interface MedBatch { drug: string; qty: number; expiresAt: number }

export interface Facility {
  id: number; node: NodeId; name: string; tier: Tier;
  specs: Specialty[]; bedsTotal: number; bedsFree: number;
  meds: MedBatch[]; doctors: Doctor[];
}

export interface Ambulance {
  id: number; callsign: string; cls: AmbClass; state: AmbState;
  at: NodeId; missionId: number; edgeProgress: number;
}

export interface Emergency {
  id: number; village: NodeId; urgency: Urgency; need: Specialty;
  caller: CallerType; filedAt: number; status: EmgStatus; missionId: number;
}

export interface Mission {
  id: number; emg: number; amb: number; facility: number;
  tDispatch: number; tSceneArrive: number; tSceneLeave: number; tFacilityArrive: number;
  cost: { responseS: number; onSceneS: number; transportS: number; waitS: number };
  trace: DecisionTrace;
}

export interface FacilityEval {
  facilityId: number; eligible: boolean; travelS: number; waitS: number; totalS: number;
  reject?: 'NO_SPECIALTY' | 'NO_BEDS' | 'NO_MEDS' | 'UNREACHABLE';
}

export interface DecisionTrace {
  emgId: number; evals: FacilityEval[]; chosenId: number;
  ambCallsign: string; ambTravelS: number; summary: string;
}

// ---- World (serialized form in district.json uses plain arrays) ----

export interface Village { node: NodeId; name: string; pop: number }

export interface World {
  source: 'osm' | 'procedural'; seed: number; nodeCount: number;
  lat: Float64Array; lng: Float64Array;
  adjOff: Uint32Array; adjDst: Uint32Array; adjW: Uint32Array;
  adjLen: Uint32Array; adjCls: Uint8Array;
  villages: Village[]; facilities: Facility[]; ambulances: Ambulance[];
  bbox: [number, number, number, number];
}

export interface PathResult {
  dist: number; path: NodeId[]; found: boolean;
  stats: { ms: number; expanded: number; relaxed: number; heapOps: number };
}
