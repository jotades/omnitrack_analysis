import type { CompareRow, PatientTrialSummary, PerformanceCorrelations, SessionPayload, SessionRow, TrialRow } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchSessions(): Promise<SessionRow[]> {
  const data = await getJson<{ sessions: SessionRow[] }>('/api/sessions');
  return data.sessions;
}

export async function refreshIndex(): Promise<{ ok: boolean; sessions: number }> {
  const res = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  performanceCorrelationsPromise = null; // backend cache was just cleared too — don't keep serving the stale numbers
  return res.json();
}

export async function fetchSessionDetail(
  sessionId: number,
  alpha: number,
  smoothTrajectory: boolean,
  smoothOnlySeeker: boolean,
  maxPoints = 2000,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const params = new URLSearchParams({
    alpha: String(alpha),
    smooth_trajectory: String(smoothTrajectory),
    smooth_only_seeker: String(smoothOnlySeeker),
    max_points: String(maxPoints),
  });
  return getJson<SessionPayload>(`/api/session/${sessionId}?${params}`, { signal });
}

export async function fetchCompareRows(opts: {
  patients?: string[];
  condition?: string;
  pathId?: string;
  phase?: string;
  includeSuspicious?: boolean;
}): Promise<CompareRow[]> {
  const params = new URLSearchParams();
  opts.patients?.forEach((p) => params.append('patients', p));
  if (opts.condition) params.set('condition', opts.condition);
  if (opts.pathId) params.set('path_id', opts.pathId);
  if (opts.phase) params.set('phase', opts.phase);
  params.set('include_suspicious', String(opts.includeSuspicious ?? true));
  const data = await getJson<{ rows: CompareRow[] }>(`/api/compare?${params}`);
  return data.rows;
}

export async function fetchTrialRows(opts: {
  patients?: string[];
  condition?: string;
  pathId?: string;
  includeSuspicious?: boolean;
  signal?: AbortSignal;
}): Promise<TrialRow[]> {
  const params = new URLSearchParams();
  opts.patients?.forEach((p) => params.append('patients', p));
  if (opts.condition) params.set('condition', opts.condition);
  if (opts.pathId) params.set('path_id', opts.pathId);
  params.set('include_suspicious', String(opts.includeSuspicious ?? true));
  const data = await getJson<{ rows: TrialRow[] }>(`/api/trials/compare?${params}`, { signal: opts.signal });
  return data.rows;
}

export async function fetchTrialsSummary(patients?: string[], signal?: AbortSignal): Promise<PatientTrialSummary[]> {
  const params = new URLSearchParams();
  patients?.forEach((p) => params.append('patients', p));
  const data = await getJson<{ rows: PatientTrialSummary[] }>(`/api/trials/summary?${params}`, { signal });
  return data.rows;
}

/** Dataset-wide Pearson correlation between speed/acceleration and trial
 * outcome — the same single dataset-wide result for every mini-card, so the
 * first caller's in-flight request is shared (module-level singleton
 * promise) instead of every simultaneously-mounted card firing its own. The
 * backend caches it too (cleared by /api/refresh), so a second render after
 * that just re-awaits a cheap already-resolved fetch. */
let performanceCorrelationsPromise: Promise<PerformanceCorrelations> | null = null;
export function fetchPerformanceCorrelations(): Promise<PerformanceCorrelations> {
  if (!performanceCorrelationsPromise) {
    performanceCorrelationsPromise = getJson<PerformanceCorrelations>('/api/performance/correlations').catch((err) => {
      performanceCorrelationsPromise = null; // let the next mount retry instead of caching a failure forever
      throw err;
    });
  }
  return performanceCorrelationsPromise;
}

export async function fetchPatientInclusion(): Promise<Record<string, boolean>> {
  const data = await getJson<{ inclusion: Record<string, boolean> }>('/api/patient-inclusion');
  return data.inclusion;
}

export async function savePatientInclusion(patient: string, included: boolean): Promise<Record<string, boolean>> {
  const res = await fetch(`${API_BASE}/api/patient-inclusion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient, included }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.inclusion;
}

export async function saveAnnotation(payload: {
  patient: string;
  condition: string;
  pathId: string;
  explorationSessionId: number | null;
  manualLost: boolean | null;
  comment: string;
  excludedFromStats?: boolean;
}): Promise<{ manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }> {
  const res = await fetch(`${API_BASE}/api/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient: payload.patient,
      condition: payload.condition,
      path_id: payload.pathId,
      exploration_session_id: payload.explorationSessionId,
      manual_lost: payload.manualLost,
      comment: payload.comment,
      excluded_from_stats: payload.excludedFromStats ?? false,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** {`${patient}|${condition}|${path_id}`: {target_id: [x, y]}} — manually
 * entered coordinates for targets whose sensor was never tracked (e.g.
 * haptic_on_object_intes, which only tracked P1). */
export async function fetchTargetCoordinates(): Promise<Record<string, Record<string, [number, number]>>> {
  const data = await getJson<{ coordinates: Record<string, Record<string, [number, number]>> }>('/api/target-coordinates');
  return data.coordinates;
}

export async function saveTargetCoordinate(payload: {
  patient: string;
  condition: string;
  pathId: string;
  targetId: string;
  x: number;
  y: number;
}): Promise<Record<string, [number, number]>> {
  const res = await fetch(`${API_BASE}/api/target-coordinates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient: payload.patient,
      condition: payload.condition,
      path_id: payload.pathId,
      target_id: payload.targetId,
      x: payload.x,
      y: payload.y,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.coordinates;
}

/** {`${patient}|${condition}|${path_id}`: {targets_found: {target_id: bool}, in_order: bool | null}}
 * — manual found/in-order overrides, for when the automatic
 * feedback/distance-based detection gets it wrong (mainly under
 * haptic_on_object_intes, next to the manual coordinates above). */
export async function fetchManualDiscoveryOverrides(): Promise<
  Record<string, { targets_found: Record<string, boolean>; in_order: boolean | null }>
> {
  const data = await getJson<{ overrides: Record<string, { targets_found: Record<string, boolean>; in_order: boolean | null }> }>('/api/manual-discovery');
  return data.overrides;
}

export async function saveManualTargetFound(payload: {
  patient: string;
  condition: string;
  pathId: string;
  targetId: string;
  /** null clears the override and reverts to automatic detection. */
  found: boolean | null;
}): Promise<{ targets_found: Record<string, boolean>; in_order: boolean | null }> {
  const res = await fetch(`${API_BASE}/api/manual-discovery/target-found`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient: payload.patient,
      condition: payload.condition,
      path_id: payload.pathId,
      target_id: payload.targetId,
      found: payload.found,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.override;
}

export async function saveManualInOrder(payload: {
  patient: string;
  condition: string;
  pathId: string;
  /** null clears the override and reverts to automatic detection. */
  inOrder: boolean | null;
}): Promise<{ targets_found: Record<string, boolean>; in_order: boolean | null }> {
  const res = await fetch(`${API_BASE}/api/manual-discovery/in-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient: payload.patient,
      condition: payload.condition,
      path_id: payload.pathId,
      in_order: payload.inOrder,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.override;
}

/** Corrects a trial's learning/exploration recordings that were mislabeled at
 * collection time — swaps which file resolves to which phase. Never touches
 * the raw session JSON; a `/api/refresh` is still needed afterward to see it
 * reflected in session pairing / trial metrics. */
export async function swapPhase(payload: {
  learningFileName: string;
  explorationFileName: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/phase-swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      learning_file_name: payload.learningFileName,
      exploration_file_name: payload.explorationFileName,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveActivationDistance(payload: {
  sessionId: number;
  minActivationDistance: number;
  maxActivationDistance: number;
}): Promise<{ min_activation_distance: number; max_activation_distance: number; updated_entries: number }> {
  const res = await fetch(`${API_BASE}/api/session/${payload.sessionId}/activation-distance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      min_activation_distance: payload.minActivationDistance,
      max_activation_distance: payload.maxActivationDistance,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** Server-rendered (matplotlib) presentation-ready bar chart PNG — an
 * alternative to screenshotting the live recharts version, with consistent
 * styling/DPI regardless of the viewer's browser/zoom. */
export async function fetchBarChartPng(payload: {
  title: string;
  labels: string[];
  values: number[];
  yLabel?: string;
  yMax?: number;
  yMajorUnit?: number;
  color?: string;
}): Promise<Blob> {
  const res = await fetch(`${API_BASE}/api/charts/bar-png`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: payload.title,
      labels: payload.labels,
      values: payload.values,
      y_label: payload.yLabel ?? '%',
      y_max: payload.yMax ?? 100,
      y_major_unit: payload.yMajorUnit ?? 25,
      color: payload.color ?? '#3b5bfd',
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.blob();
}
