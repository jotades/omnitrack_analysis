import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { fetchStatsExclusions, savePatientInclusion } from '../api';
import { useEditMode } from '../lib/editMode';
import { conditionLabel, participantLabel } from '../lib/glossary';
import type { CompareRow, PatientTrialSummary, SessionRow, TrialRow } from '../types';
import { avgBy, fmtNum, maxBy, sumBy } from '../lib/aggregate';
import { ConditionTrajectoriesGrid } from './ConditionTrajectoriesGrid';
import { PhaseToggle, type Phase } from './PhaseToggle';

interface PatientTrialAggregate {
  /** Raw TrialRow count fetched for this patient — includes every retried
   * attempt, so it can be higher than the number of trials actually run. */
  attemptsLoaded: number;
  /** Distinct (condition, path) trials — what "N trials" should mean. */
  validTrials: number;
  avgOverlap: number | null;
  totalStops: number;
  totalBorder: number;
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

/** Same key shape used for the shared excludedTrialOverrides map in App.tsx —
 * one entry per exploration attempt, matching how the backend annotation is keyed. */
function trialOverrideKey(patient: string, condition: string, pathId: string, explorationSessionId: number | null) {
  return `${patient}|${condition}|${pathId}|${explorationSessionId ?? 'none'}`;
}

/** Same key shape used for the shared attemptChoices map in App.tsx. */
function attemptChoiceKey(patient: string, condition: string, pathId: string, phase: string) {
  return `${patient}|${condition}|${pathId}|${phase}`;
}

/** One collapsible "dropdown" per patient — named after the patient, opens to
 * reveal their learning-vs-exploration grid. Session rows (cheap) are still
 * bulk-fetched once for every patient by the parent App, so the session
 * totals are visible on the collapsed header without opening anything — but
 * trial rows (expensive: overlap, Fréchet, DTW...) are only requested the
 * first time THIS patient's dropdown is opened (see the effect below), so
 * the trial-aggregate tiles and the mini-card grid both start empty/loading
 * until then. Only the mini-chart trajectory rendering itself
 * (ConditionTrajectoriesGrid's own session-payload fetch) stays lazy beyond
 * that, same as before. */
function PatientTrialSection({
  patient, sessions, summary, sessionRows, trialRows, trialAggregate, dataLoading, onRequestTrialRows, onRefreshPatientTrialRows, onAnnotationSaved,
  included, onSetIncluded, attemptChoices, onSetAttemptChoice, statsExclusion,
}: {
  /** Reason this participant is left out of the ANOVA and mixed models, if they are. */
  statsExclusion?: string;
  patient: string;
  sessions: SessionRow[];
  summary?: PatientTrialSummary;
  sessionRows: CompareRow[];
  trialRows: TrialRow[];
  trialAggregate?: PatientTrialAggregate;
  dataLoading: boolean;
  onRequestTrialRows: (patients: string[]) => void;
  onRefreshPatientTrialRows: (patient: string) => void;
  onAnnotationSaved?: (info: { condition: string; pathId: string; explorationSessionId: number | null; excludedFromStats: boolean }) => void;
  included: boolean;
  onSetIncluded: (included: boolean) => void;
  attemptChoices: Record<string, number>;
  onSetAttemptChoice: (condition: string, pathId: string, phase: string, sessionId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedPhase, setSelectedPhase] = useState<Phase>('exploration');
  const editMode = useEditMode();

  // Fetch this patient's trial metrics the first time their dropdown opens —
  // onRequestTrialRows is a no-op if already cached/in flight, so this is
  // safe to call again on every reopen.
  useEffect(() => {
    if (open) onRequestTrialRows([patient]);
  }, [open, patient, onRequestTrialRows]);

  // Owned here (not inside ConditionTrajectoriesGrid) so the toolbar settings
  // survive closing/reopening the dropdown — the grid itself only mounts
  // while `open`, so state kept there would reset to defaults every time.
  const [showBorder, setShowBorder] = useState(true);
  const [showAnchors, setShowAnchors] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  // Off by default — the ideal path is a new, still-being-validated overlay,
  // not something to surface unasked on every mini-card.
  const [showIdealPath, setShowIdealPath] = useState(false);
  const [alpha, setAlpha] = useState(0.2);
  const [smoothTrajectory, setSmoothTrajectory] = useState(true);
  const [smoothOnlySeeker, setSmoothOnlySeeker] = useState(true);

  // ConditionTrajectoriesGrid keys its choices without a patient prefix
  // (`${condition}|${path}|${phase}`, one instance = one patient) — strip
  // the patient prefix off the shared, all-patients map from App.tsx.
  const choicesForPatient = useMemo(() => {
    const prefix = `${patient}|`;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(attemptChoices)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
    }
    return out;
  }, [attemptChoices, patient]);

  const availability = useMemo(() => ({
    learning: sessionRows.some((r) => r.phase === 'learning'),
    exploration: sessionRows.some((r) => r.phase === 'exploration'),
  }), [sessionRows]);

  const sessionSummary = useMemo(() => {
    const rows = sessionRows.filter((r) => r.phase === selectedPhase);
    if (!rows.length) return null;
    return {
      sessions: rows.length,
      totalDurationMin: sumBy(rows, 'duration_s') / 60,
      totalFeedback: sumBy(rows, 'feedback_events'),
      totalDistanceM: sumBy(rows, 'total_distance_m'),
      meanSpeed: avgBy(rows, 'mean_speed_m_s'),
      maxAccel: maxBy(rows, 'max_accel_norm'),
    };
  }, [sessionRows, selectedPhase]);

  // One unified tile grid: trial-level stats (deduplicated to one entry per
  // distinct condition×path trial) first, then the phase-scoped session totals.
  // "Valid trials" and "Attempts loaded" are kept as two separate tiles on
  // purpose — a trial with 2 retries still counts once as a trial.
  const headerTiles = [
    ...(trialAggregate ? [
      { label: 'Valid trials', value: String(trialAggregate.validTrials) },
      { label: 'Attempts loaded', value: String(trialAggregate.attemptsLoaded) },
      { label: 'Avg overlap', value: fmtNum(trialAggregate.avgOverlap, 0, '%') },
      { label: 'Pauses total', value: String(trialAggregate.totalStops) },
      { label: 'Border crossings', value: String(trialAggregate.totalBorder) },
    ] : []),
    ...(sessionSummary ? [
      { label: 'Sessions', value: String(sessionSummary.sessions) },
      { label: 'Duration', value: fmtNum(sessionSummary.totalDurationMin, 1, ' min') },
      { label: 'Feedback', value: String(sessionSummary.totalFeedback) },
      { label: 'Distance', value: fmtNum(sessionSummary.totalDistanceM, 1, ' m') },
      { label: 'Mean speed', value: fmtNum(sessionSummary.meanSpeed, 2, ' m/s') },
      { label: 'Max accel', value: fmtNum(sessionSummary.maxAccel, 2) },
    ] : []),
  ];

  // Conditions this patient never ran at all (e.g. missing an entire
  // modality/target pairing) — worth flagging since it's easy to miss when
  // scrolling past a dropdown that otherwise looks complete.
  const missingConditions = useMemo(() => {
    const allConditions = uniq(sessions.map((s) => s.condition));
    const patientConditions = new Set(sessions.filter((s) => s.patient === patient).map((s) => s.condition));
    return allConditions
      .filter((c) => !patientConditions.has(c))
      .map((c) => conditionLabel(c));
  }, [sessions, patient]);

  return (
    <section className="card">
      <div className="collapseHeaderRow">
        <button type="button" className="collapseHeader" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <ChevronDown size={18} className={`collapseChevron ${open ? 'open' : ''}`} />
          <span className="collapseTitle">
            <strong>{participantLabel(patient)}</strong>
            <small>
              Learning vs exploration phase — every condition × route this participant walked
              {summary ? ` · ${summary.lost_trials}/${summary.total_trials} trials lost` : ''}
            </small>
          </span>
          {summary && summary.lost_trials > 0 ? <span className="warningBadge">{summary.lost_trials} lost</span> : null}
          {statsExclusion ? (
            <span className="statsExcludedBadge" title={`Left out of the ANOVA and the mixed model (data quality): ${statsExclusion}. Still shown here and in the descriptive totals.`}>
              Not in statistics: {statsExclusion.split(':')[0]}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="patientRefreshButton"
          title={`Re-fetch ${patient}'s trial data from the backend now, without waiting to reopen this dropdown or running the app-wide Refresh index — picks up any annotation/coordinate/override edit immediately, but not a brand-new raw session file (that still needs Refresh index).`}
          disabled={dataLoading}
          onClick={(e) => { e.stopPropagation(); onRefreshPatientTrialRows(patient); }}
        >
          <RefreshCw size={15} className={dataLoading ? 'spin' : undefined} />
        </button>
      </div>

      <div className="patientHeaderExtra">
        <div className="patientHeaderControls">
          <PhaseToggle selected={selectedPhase} available={availability} onSelect={setSelectedPhase} />
          <label className="inlineCheck" title={"Whether this participant's recordings count in the descriptive totals of General statistics (and, unless excluded for data quality, in the ANOVA)." + (editMode ? '' : ' Turn on edit mode to change.')}>
            <input type="checkbox" checked={included} disabled={!editMode} onChange={(e) => onSetIncluded(e.target.checked)} />
            Show in General statistics
          </label>
        </div>
        {headerTiles.length ? (
          <div className="patientHeaderStats">
            {headerTiles.map((t) => (
              <div key={t.label} className="patientHeaderStat"><span>{t.label}</span><strong>{t.value}</strong></div>
            ))}
          </div>
        ) : null}
        {missingConditions.length ? (
          <div className="missingConditionsNote">
            Missing condition{missingConditions.length > 1 ? 's' : ''}: {missingConditions.join(', ')}
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="conditionGridBody">
          <ConditionTrajectoriesGrid
            sessions={sessions}
            patient={patient}
            trialRows={trialRows}
            bare
            onAnnotationSaved={onAnnotationSaved}
            showBorder={showBorder}
            onShowBorder={setShowBorder}
            showAnchors={showAnchors}
            onShowAnchors={setShowAnchors}
            showGrid={showGrid}
            onShowGrid={setShowGrid}
            showIdealPath={showIdealPath}
            onShowIdealPath={setShowIdealPath}
            alpha={alpha}
            onAlpha={setAlpha}
            smoothTrajectory={smoothTrajectory}
            onSmoothTrajectory={setSmoothTrajectory}
            smoothOnlySeeker={smoothOnlySeeker}
            onSmoothOnlySeeker={setSmoothOnlySeeker}
            choices={choicesForPatient}
            onSetChoice={onSetAttemptChoice}
          />
        </div>
      ) : null}
    </section>
  );
}

interface Props {
  sessions: SessionRow[];
  sessionRows: CompareRow[];
  allTrialRows: TrialRow[];
  patientSummaries: PatientTrialSummary[];
  /** Patients whose trial-level metrics (overlap, Fréchet, DTW...) are
   * currently being fetched — see onRequestTrialRows below. */
  loadingPatients: Set<string>;
  /** Triggers the (expensive, per-patient) trial-metrics fetch for this
   * patient — called once, the first time their dropdown is opened, since
   * fetching this for every patient up front used to take minutes. Cheap to
   * call again: the parent skips patients it already has cached. */
  onRequestTrialRows: (patients: string[]) => void;
  /** Manual per-patient "Refresh" button — forces a re-fetch of just this
   * one patient's trial rows even though a cached copy already exists. */
  onRefreshPatientTrialRows: (patient: string) => void;
  onRefreshPatientSummaries: () => void;
  inclusion: Record<string, boolean>;
  onSetInclusion: (patient: string, included: boolean) => void;
  excludedTrialOverrides: Record<string, boolean>;
  onSetTrialExcluded: (patient: string, condition: string, pathId: string, explorationSessionId: number | null, excluded: boolean) => void;
  attemptChoices: Record<string, number>;
  onSetAttemptChoice: (patient: string, condition: string, pathId: string, phase: string, sessionId: number) => void;
}

export function TrialsPanel({
  sessions, sessionRows, allTrialRows, patientSummaries, loadingPatients, onRequestTrialRows, onRefreshPatientTrialRows, onRefreshPatientSummaries,
  inclusion, onSetInclusion, excludedTrialOverrides, onSetTrialExcluded, attemptChoices, onSetAttemptChoice,
}: Props) {
  const [statsExclusions, setStatsExclusions] = useState<Record<string, string>>({});
  useEffect(() => { fetchStatsExclusions().then(setStatsExclusions).catch(() => {}); }, []);
  // ---------------------------------------------------------------------
  // Trial overview: one collapsible "dropdown" per patient, named after the
  // patient. Opening it reveals every condition × path they ran (learning-vs-
  // exploration mini charts + the aggregated trial metrics for each).
  // ---------------------------------------------------------------------
  const patients = useMemo(() => uniq(sessions.map((s) => s.patient)), [sessions]);

  const summaryByPatient = useMemo(() => {
    const map = new Map<string, PatientTrialSummary>();
    for (const s of patientSummaries) map.set(s.patient, s);
    return map;
  }, [patientSummaries]);

  const sessionRowsByPatient = useMemo(() => {
    const map = new Map<string, CompareRow[]>();
    for (const r of sessionRows) {
      const arr = map.get(r.patient) ?? [];
      arr.push(r);
      map.set(r.patient, arr);
    }
    return map;
  }, [sessionRows]);

  // Toggling "exclude from statistics" saves instantly but the bulk trial
  // fetch that feeds this whole tab isn't cheap to re-run (tens of seconds) —
  // apply the shared override map on top of the last fetched rows instead, so
  // header tiles here (and General statistics) update live without a refetch.
  const effectiveTrialRows = useMemo(() => {
    if (!Object.keys(excludedTrialOverrides).length) return allTrialRows;
    return allTrialRows.map((r) => {
      const key = trialOverrideKey(r.patient, r.condition, r.path_id, r.exploration_session_id);
      const override = excludedTrialOverrides[key];
      return override === undefined || override === r.excluded_from_stats ? r : { ...r, excluded_from_stats: override };
    });
  }, [allTrialRows, excludedTrialOverrides]);

  const trialRowsByPatient = useMemo(() => {
    const map = new Map<string, TrialRow[]>();
    for (const r of effectiveTrialRows) {
      const arr = map.get(r.patient) ?? [];
      arr.push(r);
      map.set(r.patient, arr);
    }
    return map;
  }, [effectiveTrialRows]);

  const trialAggregateByPatient = useMemo(() => {
    const map = new Map<string, PatientTrialAggregate>();
    for (const [p, patientRows] of trialRowsByPatient) {
      // Rows arrive in chronological order (see build_trials_df), so keeping
      // the last row per (condition, path) keeps the most recent attempt —
      // one row per trial actually run, regardless of how many retries.
      // Attempts flagged excluded_from_stats (hardware error / bad trial) are
      // skipped entirely so an earlier, non-excluded attempt of the same
      // trial still counts instead. If the researcher manually picked a
      // specific exploration attempt in the mini-card dropdown, that pick
      // wins over "latest" — they chose it for a reason.
      const latestByTrial = new Map<string, TrialRow>();
      const chosenByTrial = new Map<string, TrialRow>();
      for (const r of patientRows) {
        if (r.excluded_from_stats) continue;
        const key = `${r.condition}|${r.path_id}`;
        latestByTrial.set(key, r);
        const chosenId = attemptChoices[attemptChoiceKey(p, r.condition, r.path_id, 'exploration')];
        if (chosenId !== undefined && r.exploration_session_id === chosenId) chosenByTrial.set(key, r);
      }
      // A recording fixed by hand on the backend (recording_pins.json) wins over a browser pick.
      const pinnedTrials = new Set(patientRows.filter((r) => r.exploration_pinned && !r.excluded_from_stats).map((r) => `${r.condition}|${r.path_id}`));
      for (const [key, row] of chosenByTrial) if (!pinnedTrials.has(key)) latestByTrial.set(key, row);
      const validRows = Array.from(latestByTrial.values());
      map.set(p, {
        attemptsLoaded: patientRows.length,
        validTrials: validRows.length,
        avgOverlap: avgBy(validRows, 'overlap_pct'),
        totalStops: sumBy(validRows, 'exploration_pause_count'),
        totalBorder: sumBy(validRows, 'border_reached_count'),
      });
    }
    return map;
  }, [trialRowsByPatient, attemptChoices]);

  return (
    <>
      <section className="card comparisonControls">
        <div className="cardHeader">
          <div>
            <h2>Trial overview: exploration vs. learning</h2>
            <p>One dropdown per participant — open it to see every condition × route they ran, with the learning/exploration trajectory overlay and the aggregated trial metrics.</p>
          </div>
        </div>
      </section>

      <div className="patientTrialList">
        {patients.map((patient) => (
          <PatientTrialSection
            key={patient}
            patient={patient}
            sessions={sessions}
            summary={summaryByPatient.get(patient)}
            sessionRows={sessionRowsByPatient.get(patient) ?? []}
            trialRows={trialRowsByPatient.get(patient) ?? []}
            trialAggregate={trialAggregateByPatient.get(patient)}
            dataLoading={loadingPatients.has(patient)}
            onRequestTrialRows={onRequestTrialRows}
            onRefreshPatientTrialRows={onRefreshPatientTrialRows}
            onAnnotationSaved={(info) => {
              onSetTrialExcluded(patient, info.condition, info.pathId, info.explorationSessionId, info.excludedFromStats);
              onRefreshPatientSummaries();
            }}
            included={inclusion[patient] !== false}
            statsExclusion={statsExclusions[patient]}
            onSetIncluded={(v) => {
              onSetInclusion(patient, v);
              savePatientInclusion(patient, v).catch(() => {});
            }}
            attemptChoices={attemptChoices}
            onSetAttemptChoice={(condition, pathId, phase, sessionId) => onSetAttemptChoice(patient, condition, pathId, phase, sessionId)}
          />
        ))}
      </div>
    </>
  );
}
