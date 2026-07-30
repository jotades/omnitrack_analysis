import { useMemo, useState } from 'react';
import {
  AlertTriangle, Crosshair, Footprints, Gauge, Info, ListChecks, PauseCircle, Radio, RefreshCw, Route, RotateCw, ShieldAlert, Timer, Users, Zap,
} from 'lucide-react';
import type { CompareRow, PatientTrialSummary, SessionRow, TargetDiscovery, TrialRow } from '../types';
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

  // Per-PATIENT outcome classification — every included patient lands in
  // exactly one bucket: the outcome they reached most often (the mode)
  // across their own trials, so the buckets always sum to the total number
  // of classifiable patients. This priority order both defines each trial's
  // category and breaks ties when a patient split evenly between two modes
  // (the better-ranked one wins): found more targets > in the
  // learning-taught order > completed (returned within the threshold).
  const OUTCOME_CATEGORIES: Array<{
    key: 'found3InOrderCompleted' | 'found3InOrderNotCompleted' | 'found3OutOfOrderCompleted' | 'found3OutOfOrderNotCompleted'
      | 'found2Completed' | 'found2NotCompleted' | 'found1Completed' | 'found1NotCompleted' | 'found0Completed' | 'found0NotCompleted';
    label: string;
    test: (td: TargetDiscovery, isCompleted: boolean) => boolean;
  }> = [
    { key: 'found3InOrderCompleted', label: 'Found 3, in order & completed', test: (td, c) => td.found_count === 3 && td.in_order === true && c },
    { key: 'found3InOrderNotCompleted', label: 'Found 3, in order & not completed', test: (td, c) => td.found_count === 3 && td.in_order === true && !c },
    { key: 'found3OutOfOrderCompleted', label: 'Found 3, out of order & completed', test: (td, c) => td.found_count === 3 && td.in_order === false && c },
    { key: 'found3OutOfOrderNotCompleted', label: 'Found 3, out of order & not completed', test: (td, c) => td.found_count === 3 && td.in_order === false && !c },
    { key: 'found2Completed', label: 'Found 2 & completed', test: (td, c) => td.found_count === 2 && c },
    { key: 'found2NotCompleted', label: 'Found 2 & not completed', test: (td, c) => td.found_count === 2 && !c },
    { key: 'found1Completed', label: 'Found 1 & completed', test: (td, c) => td.found_count === 1 && c },
    { key: 'found1NotCompleted', label: 'Found 1 & not completed', test: (td, c) => td.found_count === 1 && !c },
    { key: 'found0Completed', label: 'Found 0 & completed', test: (td, c) => td.found_count === 0 && c },
    { key: 'found0NotCompleted', label: 'Found 0 & not completed', test: (td, c) => td.found_count === 0 && !c },
  ];

  const discoveryBreakdown = useMemo(() => {
    const trialsByPatient = new Map<string, TrialRow[]>();
    for (const r of validTrialRows) {
      if (!r.target_discovery) continue;
      const arr = trialsByPatient.get(r.patient) ?? [];
      arr.push(r);
      trialsByPatient.set(r.patient, arr);
    }
    const counts = Object.fromEntries(OUTCOME_CATEGORIES.map((c) => [c.key, 0])) as Record<string, number>;
    for (const [, rows] of trialsByPatient) {
      // Tally every trial into its category, then take the MODE (the
      // category this patient landed in most often across all their
      // trials) — a "best ever" pick made almost everyone show up under
      // "found 3" since most patients succeed at least once out of ~8
      // attempts, hiding that most of their individual trials don't.
      // Ties go to the better-ranked category (OUTCOME_CATEGORIES order).
      const tally = new Map<string, number>();
      for (const r of rows) {
        const isCompleted = completed(r);
        for (const cat of OUTCOME_CATEGORIES) {
          if (cat.test(r.target_discovery!, isCompleted)) {
            tally.set(cat.key, (tally.get(cat.key) ?? 0) + 1);
            break; // each trial belongs to exactly one category
          }
        }
      }
      let modeKey: string | null = null;
      let modeCount = -1;
      for (const cat of OUTCOME_CATEGORIES) {
        const n = tally.get(cat.key) ?? 0;
        if (n > modeCount) { modeCount = n; modeKey = cat.key; }
      }
      if (modeKey) counts[modeKey] += 1;
    }
    return { counts, classifiedPatients: trialsByPatient.size };
  }, [validTrialRows, returnThreshold]);

  const impactBreakdown = useMemo(() => {
    const patientsWithImpact = new Set<string>();
    const perTarget: Record<string, number> = {};
    for (const r of validTrialRows) {
      const values = Object.values(r.target_impacts ?? {});
      if (values.some((v) => v > 0)) patientsWithImpact.add(r.patient);
      for (const [tid, count] of Object.entries(r.target_impacts ?? {})) {
        perTarget[tid] = (perTarget[tid] ?? 0) + count;
      }
    }
    return { patientsWithImpact: patientsWithImpact.size, perTarget };
  }, [validTrialRows]);

  const conditionBreakdown = useMemo(() => {
    const byCondition = new Map<string, { label: string; total: number; foundAll: number; patients: Set<string> }>();
    for (const r of validTrialRows) {
      const entry = byCondition.get(r.condition) ?? { label: r.condition_label || r.condition, total: 0, foundAll: 0, patients: new Set<string>() };
      entry.total += 1;
      entry.patients.add(r.patient);
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
      .map(([condition, v]) => ({ condition, ...v, patientCount: v.patients.size }));
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

  // Denominators shown as "N patients · M trials/attempts" context lines —
  // computed once here since several sections below (and the sections above)
  // share the same validTrialRows pool.
  const behavioralPatientCount = useMemo(() => new Set(validTrialRows.map((r) => r.patient)).size, [validTrialRows]);
  const explorationAttempts = useMemo(() => includedSessionRows.filter((r) => r.phase === 'exploration' && r.duration_s != null), [includedSessionRows]);
  const explorationAttemptPatientCount = useMemo(() => new Set(explorationAttempts.map((r) => r.patient)).size, [explorationAttempts]);

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
          <div>
            <h2>Trial totals</h2>
            <p>Learning-vs-exploration trial metrics, deduplicated to one entry per distinct condition × path trial (latest non-excluded attempt).</p>
            <p className="sectionCount">{behavioralPatientCount} patients · {validTrialRows.length} trials</p>
          </div>
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
            <p className="sectionCount">{behavioralPatientCount} patients · {validTrialRows.length} trials</p>
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

        <p className="miniHint" style={{ padding: '0 20px' }}>
          Number of PATIENTS (never trials) — each patient counted exactly once, in whichever outcome they landed in
          <strong> most often</strong> across their own trials (the mode, not their single best attempt — see{' '}
          <span className="miniStatInfo" title={
            "Why the mode, not the best trial: with ~8 trials each, almost every patient succeeds at finding all 3 targets "
            + "at least once — a 'best ever' summary would put nearly everyone under 'Found 3', hiding that most of an "
            + "individual patient's trials may not find everything (e.g. one patient's real trials were "
            + "[2, 3, 1, 1, 1, 0] targets found — only 1 of 6 attempts found all 3, so they land under 'Found 1', "
            + "not 'Found 3'). Ties between categories are broken in favor of the better outcome."
          }>
            <Info size={12} />
          </span>). The categories below always sum to{' '}
          <strong>{discoveryBreakdown.classifiedPatients}</strong>, the number of patients with at least one comparable trial
          (out of {behavioralPatientCount} total valid patients — the rest have no trial with both learning and exploration data to compare).
        </p>

        <div className="outcomeGroup">
          <h4>Found all 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>In order &amp; completed</span><strong>{discoveryBreakdown.counts.found3InOrderCompleted}</strong></div>
            <div className="metricCard"><span>In order &amp; not completed</span><strong>{discoveryBreakdown.counts.found3InOrderNotCompleted}</strong></div>
            <div className="metricCard"><span>Out of order &amp; completed</span><strong>{discoveryBreakdown.counts.found3OutOfOrderCompleted}</strong></div>
            <div className="metricCard"><span>Out of order &amp; not completed</span><strong>{discoveryBreakdown.counts.found3OutOfOrderNotCompleted}</strong></div>
          </div>
        </div>
        <div className="outcomeGroup">
          <h4>Found 2 of 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Completed</span><strong>{discoveryBreakdown.counts.found2Completed}</strong></div>
            <div className="metricCard"><span>Not completed</span><strong>{discoveryBreakdown.counts.found2NotCompleted}</strong></div>
          </div>
        </div>
        <div className="outcomeGroup">
          <h4>Found 1 of 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Completed</span><strong>{discoveryBreakdown.counts.found1Completed}</strong></div>
            <div className="metricCard"><span>Not completed</span><strong>{discoveryBreakdown.counts.found1NotCompleted}</strong></div>
          </div>
        </div>
        <div className="outcomeGroup">
          <h4>Found 0 of 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Completed</span><strong>{discoveryBreakdown.counts.found0Completed}</strong></div>
            <div className="metricCard"><span>Not completed</span><strong>{discoveryBreakdown.counts.found0NotCompleted}</strong></div>
          </div>
        </div>

        <div className="outcomeGroup">
          <h4>Other (not part of the classification above — a patient can appear here and in one bucket above)</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Patients with ≥1 object impact</span><strong>{impactBreakdown.patientsWithImpact}</strong></div>
          </div>
        </div>

        <div className="behavioralSubgrid">
          <div className="behavioralSubcard">
            <h3>Success by condition</h3>
            <p className="miniHint">{behavioralPatientCount} patients · {validTrialRows.length} trials analyzed.</p>
            <table className="miniTable">
              <thead><tr><th>Condition</th><th>Found all targets</th><th>Valid trials</th><th>Patients</th></tr></thead>
              <tbody>
                {conditionBreakdown.map((c) => (
                  <tr key={c.condition}><td>{c.label}</td><td>{c.foundAll}</td><td>{c.total}</td><td>{c.patientCount}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="behavioralSubcard">
            <h3>Proximity escalation confirmed</h3>
            <p className="miniHint">{behavioralPatientCount} patients · {validTrialRows.length} trials analyzed. Trials where that target reached the closest proximity zone observed (bucket {proximityBreakdown.closestZone ?? '—'}).</p>
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
            <p className="miniHint">{behavioralPatientCount} patients · {validTrialRows.length} trials analyzed. Counts are impact events, not trials — one trial can register more than one.</p>
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
            <p className="miniHint">
              {explorationAttemptPatientCount} patients · {explorationAttempts.length} exploration attempts considered (session-level, not deduplicated by trial).
              Among completed attempts (falls back to all attempts if none completed that path).
            </p>
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
