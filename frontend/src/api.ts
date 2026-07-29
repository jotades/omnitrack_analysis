import type { CompareRow, PatientTrialSummary, SessionPayload, SessionRow, TrialRow } from './types';

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
