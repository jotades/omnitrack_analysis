import { useMemo, useState } from 'react';
import {
  AlertTriangle, Crosshair, Footprints, Gauge, ListChecks, PauseCircle, Radio, RefreshCw, Route, RotateCw, ShieldAlert, Timer, Users, Zap,
} from 'lucide-react';
import type { CompareRow, PatientTrialSummary, SessionRow, TrialRow } from '../types';
import { avgBy, fmtNum, maxBy, sumBy } from '../lib/aggregate';

interface Props {
  sessions: SessionRow[];
  sessionRows: CompareRow[];
  trialRows: TrialRow[];
  patientSummaries: PatientTrialSummary[];
  inclusion: Record<string, boolean>;
  dataLoading: boolean;
  excludedTrialOverrides: Record<string, boolean>;
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function trialOverrideKey(patient: string, condition: string, pathId: string, explorationSessionId: number | null) {
  return `${patient}|${condition}|${pathId}|${explorationSessionId ?? 'none'}`;
}

const PATHS = ['path_A', 'path_B', 'path_C', 'path_D', 'path_E', 'path_F', 'path_G', 'path_H'];

/** Combined totals across every patient opted in via the "Include in General
 * statistics" checkbox on the Trial metrics tab (default: everyone included).
 * Reuses the same bulk session/trial data the Trial metrics tab fetches —
 * lifted to App so switching tabs doesn't re-trigger the slow bulk fetch. */
export function GeneralStatisticsPanel({ sessions, sessionRows, trialRows, patientSummaries, inclusion, dataLoading, excludedTrialOverrides }: Props) {
  const patients = useMemo(() => uniq(sessions.map((s) => s.patient)), [sessions]);
  const includedPatients = useMemo(
    () => patients.filter((p) => inclusion[p] !== false),
    [patients, inclusion],
  );
  const includedSet = useMemo(() => new Set(includedPatients), [includedPatients]);

  const includedSessionRows = useMemo(
    () => sessionRows.filter((r) => includedSet.has(r.patient)),
    [sessionRows, includedSet],
  );

  // Same "apply saved-but-not-yet-refetched overrides" pattern as TrialsPanel,
  // so toggling "exclude from statistics" on a mini-card updates these totals
  // immediately without re-running the slow bulk trial fetch.
  const effectiveTrialRows = useMemo(() => {
    if (!Object.keys(excludedTrialOverrides).length) return trialRows;
    return trialRows.map((r) => {
      const key = trialOverrideKey(r.patient, r.condition, r.path_id, r.exploration_session_id);
      const override = excludedTrialOverrides[key];
      return override === undefined || override === r.excluded_from_stats ? r : { ...r, excluded_from_stats: override };
    });
  }, [trialRows, excludedTrialOverrides]);

  const includedAttempts = useMemo(
    () => effectiveTrialRows.filter((r) => includedSet.has(r.patient) && !r.excluded_from_stats),
    [effectiveTrialRows, includedSet],
  );

  // Deduplicate to one row per (patient, condition, path) — the most recent
  // non-excluded attempt — so a trial with retries doesn't inflate the
  // trial-level averages, and a flagged hardware-error attempt never counts.
  const validTrialRows = useMemo(() => {
    const latest = new Map<string, TrialRow>();
    for (const r of includedAttempts) latest.set(`${r.patient}|${r.condition}|${r.path_id}`, r);
    return Array.from(latest.values());
  }, [includedAttempts]);

  const attemptsLoaded = includedAttempts.length;

  const includedSummaries = useMemo(
    () => patientSummaries.filter((s) => includedSet.has(s.patient)),
    [patientSummaries, includedSet],
  );
  const lostTrials = sumBy(includedSummaries, 'lost_trials');
  const totalTrialsFromSummary = sumBy(includedSummaries, 'total_trials');

  const sessionItems = [
    { label: 'Patients included', value: `${includedPatients.length} / ${patients.length}`, icon: Users },
    { label: 'Sessions recorded', value: String(includedSessionRows.length), icon: ListChecks },
    { label: 'Total duration', value: fmtNum(sumBy(includedSessionRows, 'duration_s') / 60, 1, ' min'), icon: Timer },
    { label: 'Total feedback events', value: String(sumBy(includedSessionRows, 'feedback_events')), icon: Radio },
    { label: 'Total distance walked', value: fmtNum(sumBy(includedSessionRows, 'total_distance_m'), 1, ' m'), icon: Footprints },
    { label: 'Mean speed', value: fmtNum(avgBy(includedSessionRows, 'mean_speed_m_s'), 2, ' m/s'), icon: Gauge },
    { label: 'Max acceleration', value: fmtNum(maxBy(includedSessionRows, 'max_accel_norm'), 2), icon: Zap },
  ];

  const trialItems = [
    { label: 'Valid trials', value: String(validTrialRows.length), icon: ListChecks },
    { label: 'Attempts loaded', value: String(attemptsLoaded), icon: Route },
    { label: 'Trials lost/disrupted', value: `${lostTrials} / ${totalTrialsFromSummary}`, icon: AlertTriangle },
    { label: 'Avg route overlap', value: fmtNum(avgBy(validTrialRows, 'overlap_pct'), 0, '%'), icon: Route },
    { label: 'Avg turn deviation', value: fmtNum(avgBy(validTrialRows, 'mean_turn_deviation_deg'), 0, '°'), icon: RotateCw },
    { label: 'Wrong turns total', value: String(sumBy(validTrialRows, 'wrong_turns_count')), icon: RotateCw },
    { label: 'Avg stop-position Δ', value: fmtNum(avgBy(validTrialRows, 'stop_position_distance_m'), 2, ' m'), icon: Crosshair },
    { label: 'Avg start-position Δ', value: fmtNum(avgBy(validTrialRows, 'start_position_distance_m'), 2, ' m'), icon: Crosshair },
    { label: 'Stops total', value: String(sumBy(validTrialRows, 'stop_count')), icon: PauseCircle },
    { label: 'Border crossings total', value: String(sumBy(validTrialRows, 'border_reached_count')), icon: ShieldAlert },
  ];

  // ---------------------------------------------------------------------
  // Behavioral breakdown — target discovery, return-to-start/completion,
  // impacts, per-condition success, proximity escalation, fastest times.
  // ---------------------------------------------------------------------
  const [returnThreshold, setReturnThreshold] = useState(1.0);

  const completed = (r: TrialRow) => r.return_to_start_distance_m != null && r.return_to_start_distance_m <= returnThreshold;

  const discoveryBreakdown = useMemo(() => {
    let all3InOrder = 0;
    let found2Completed = 0, found2NotCompleted = 0;
    let found1Completed = 0, found1NotCompleted = 0;
    let found0 = 0;
    let outOfOrder = 0;
    for (const r of validTrialRows) {
      const td = r.target_discovery;
      if (!td) continue;
      const isCompleted = completed(r);
      if (td.found_count > 0 && td.in_order === false) outOfOrder += 1;
      if (td.found_count === 3 && td.in_order) all3InOrder += 1;
      else if (td.found_count === 2) { if (isCompleted) found2Completed += 1; else found2NotCompleted += 1; }
      else if (td.found_count === 1) { if (isCompleted) found1Completed += 1; else found1NotCompleted += 1; }
      else if (td.found_count === 0) found0 += 1;
    }
    return { all3InOrder, found2Completed, found2NotCompleted, found1Completed, found1NotCompleted, found0, outOfOrder };
  }, [validTrialRows, returnThreshold]);

  const impactBreakdown = useMemo(() => {
    let trialsWithImpact = 0;
    const perTarget: Record<string, number> = {};
    for (const r of validTrialRows) {
      const values = Object.values(r.target_impacts ?? {});
      if (values.some((v) => v > 0)) trialsWithImpact += 1;
      for (const [tid, count] of Object.entries(r.target_impacts ?? {})) {
        perTarget[tid] = (perTarget[tid] ?? 0) + count;
      }
    }
    return { trialsWithImpact, perTarget };
  }, [validTrialRows]);

  const conditionBreakdown = useMemo(() => {
    const byCondition = new Map<string, { label: string; total: number; foundAll: number }>();
    for (const r of validTrialRows) {
      const entry = byCondition.get(r.condition) ?? { label: r.condition_label || r.condition, total: 0, foundAll: 0 };
      entry.total += 1;
      if (r.target_discovery?.found_count === (r.target_discovery?.targets.length ?? -1) && (r.target_discovery?.targets.length ?? 0) > 0) {
        entry.foundAll += 1;
      }
      byCondition.set(r.condition, entry);
    }
    // A trial with no exploration session at all (e.g. a group with only a
    // learning recording) surfaces as a phantom row with condition = null —
    // keep it out of a sort that assumes real strings.
    return Array.from(byCondition.entries())
      .filter(([condition]) => condition != null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([condition, v]) => ({ condition, ...v }));
  }, [validTrialRows]);

  const proximityBreakdown = useMemo(() => {
    const closestByTarget = new Map<string, number>();
    for (const r of validTrialRows) {
      for (const t of r.target_discovery?.targets ?? []) {
        if (t.min_bucket == null) continue;
        const cur = closestByTarget.get(t.target_id);
        if (cur === undefined || t.min_bucket < cur) closestByTarget.set(t.target_id, t.min_bucket);
      }
    }
    const closestZone = closestByTarget.size ? Math.min(...closestByTarget.values()) : null;
    const counts = new Map<string, number>();
    if (closestZone != null) {
      for (const r of validTrialRows) {
        for (const t of r.target_discovery?.targets ?? []) {
          if (t.min_bucket === closestZone) counts.set(t.target_id, (counts.get(t.target_id) ?? 0) + 1);
        }
      }
    }
    return { closestZone, counts };
  }, [validTrialRows]);

  const fastestByPath = useMemo(() => {
    // Match at the individual-attempt level (exploration_session_id) rather
    // than the deduplicated per-trial rows, so "completed" reflects whichever
    // specific attempt is being timed, not just the trial's representative one.
    const completedSessionIds = new Set(
      includedAttempts
        .filter((r) => r.exploration_session_id != null && r.return_to_start_distance_m != null && r.return_to_start_distance_m <= returnThreshold)
        .map((r) => r.exploration_session_id)
    );
    const explorationRows = includedSessionRows.filter((r) => r.phase === 'exploration' && r.duration_s != null);
    return PATHS.map((pathId) => {
      const candidates = explorationRows.filter((r) => r.path_id === pathId);
      const completedCandidates = candidates.filter((r) => completedSessionIds.has(r.session_id));
      const pool = completedCandidates.length ? completedCandidates : candidates;
      if (!pool.length) return { pathId, patient: null as string | null, durationS: null as number | null, completedOnly: false };
      const fastest = pool.reduce((best, r) => (r.duration_s! < best.duration_s! ? r : best));
      return { pathId, patient: fastest.patient, durationS: fastest.duration_s, completedOnly: completedCandidates.length > 0 };
    });
  }, [includedSessionRows, includedAttempts, returnThreshold]);

  return (
    <>
      <section className="card comparisonControls">
        <div className="cardHeader">
          <div>
            <h2>General statistics</h2>
            <p>
              Combined totals across every included patient — {includedPatients.length} of {patients.length} included.
              Toggle a patient in/out from the "Include in General statistics" checkbox on its dropdown in the Trial metrics tab.
            </p>
          </div>
          {dataLoading ? <RefreshCw size={16} className="spin" /> : null}
        </div>
      </section>

      <section className="card">
        <div className="cardHeader">
          <div><h2>Session totals</h2><p>Every recorded session (learning + exploration) for included patients.</p></div>
        </div>
        <div className="metricGrid">
          {sessionItems.map((item) => {
            const Icon = item.icon;
            return (
              <div className="metricCard" key={item.label}>
                <div className="metricIcon"><Icon size={18} /></div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="cardHeader">
          <div><h2>Trial totals</h2><p>Learning-vs-exploration trial metrics, deduplicated to one entry per distinct condition × path trial (latest non-excluded attempt).</p></div>
        </div>
        <div className="metricGrid">
          {trialItems.map((item) => {
            const Icon = item.icon;
            return (
              <div className="metricCard" key={item.label}>
                <div className="metricIcon"><Icon size={18} /></div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="cardHeader">
          <div>
            <h2>Behavioral breakdown</h2>
            <p>Target discovery, completion, impacts and speed, all computed over the same deduplicated valid trials above.</p>
          </div>
          <label className="thresholdInput" title="A trial counts as 'completed' when the exploration's last position is within this distance of the learning session's start point.">
            Return-to-start threshold
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={returnThreshold}
              onChange={(e) => setReturnThreshold(Math.max(0.1, Number(e.target.value) || 0.1))}
            />
            m
          </label>
        </div>

        <div className="metricGrid">
          <div className="metricCard"><span>Found all 3, in order &amp; completed</span><strong>{discoveryBreakdown.all3InOrder}</strong></div>
          <div className="metricCard"><span>Found 2/3 — completed</span><strong>{discoveryBreakdown.found2Completed}</strong></div>
          <div className="metricCard"><span>Found 2/3 — not completed</span><strong>{discoveryBreakdown.found2NotCompleted}</strong></div>
          <div className="metricCard"><span>Found 1/3 — completed</span><strong>{discoveryBreakdown.found1Completed}</strong></div>
          <div className="metricCard"><span>Found 1/3 — not completed</span><strong>{discoveryBreakdown.found1NotCompleted}</strong></div>
          <div className="metricCard"><span>Found 0/3</span><strong>{discoveryBreakdown.found0}</strong></div>
          <div className="metricCard"><span>Found out of order</span><strong>{discoveryBreakdown.outOfOrder}</strong></div>
          <div className="metricCard"><span>Trials with ≥1 object impact</span><strong>{impactBreakdown.trialsWithImpact}</strong></div>
        </div>

        <div className="behavioralSubgrid">
          <div className="behavioralSubcard">
            <h3>Success by condition</h3>
            <table className="miniTable">
              <thead><tr><th>Condition</th><th>Found all targets</th><th>Valid trials</th></tr></thead>
              <tbody>
                {conditionBreakdown.map((c) => (
                  <tr key={c.condition}><td>{c.label}</td><td>{c.foundAll}</td><td>{c.total}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="behavioralSubcard">
            <h3>Proximity escalation confirmed</h3>
            <p className="miniHint">Trials where that target reached the closest proximity zone observed (bucket {proximityBreakdown.closestZone ?? '—'}).</p>
            <table className="miniTable">
              <thead><tr><th>Target</th><th>Trials reaching closest zone</th></tr></thead>
              <tbody>
                {['O1', 'O2', 'O3'].map((tid) => (
                  <tr key={tid}><td>{tid}</td><td>{proximityBreakdown.counts.get(tid) ?? 0}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="behavioralSubcard">
            <h3>Object impacts by target</h3>
            <table className="miniTable">
              <thead><tr><th>Target</th><th>Impact count</th></tr></thead>
              <tbody>
                {['O1', 'O2', 'O3'].map((tid) => (
                  <tr key={tid}><td>{tid}</td><td>{impactBreakdown.perTarget[tid] ?? 0}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="behavioralSubcard">
            <h3>Fastest completion per path</h3>
            <p className="miniHint">Among completed exploration attempts (falls back to all attempts if none completed that path).</p>
            <table className="miniTable">
              <thead><tr><th>Path</th><th>Fastest</th><th>Patient</th></tr></thead>
              <tbody>
                {fastestByPath.map((row) => (
                  <tr key={row.pathId}>
                    <td>{row.pathId.replace('path_', '')}</td>
                    <td>{row.durationS != null ? fmtNum(row.durationS, 0, ' s') : '—'}</td>
                    <td>{row.patient ?? '—'}{row.durationS != null && !row.completedOnly ? ' (no completed attempt)' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
