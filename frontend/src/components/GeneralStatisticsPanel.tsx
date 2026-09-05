import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Crosshair, FileDown, Footprints, Gauge, ListChecks, PauseCircle, Radio, RefreshCw, Route, RotateCw, ShieldAlert, Timer, Users, Zap,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { CompareRow, PatientTrialSummary, SessionRow, TargetDiscovery, TrialRow } from '../types';
import { fetchBarChartPng } from '../api';
import { avgBy, fmtNum, maxBy, stdDevBy, sumBy } from '../lib/aggregate';
import { ChartFrame } from './ChartFrame';
import { CopyAsPngButton, InfoPopover } from './InfoPopover';

const accent = '#3b5bfd';
// One distinct color per path (A..H), reused between the "fastest per path"
// curve chart and anywhere else path identity needs to be visually stable.
const PATH_COLORS: Record<string, string> = {
  path_A: '#3b5bfd', path_B: '#f79009', path_C: '#12b76a', path_D: '#d92d20',
  path_E: '#7a5af8', path_F: '#0891b2', path_G: '#e04f9e', path_H: '#a16207',
};
// path_A..path_H are reused across ALL 4 conditions (verified: every path
// letter appears under every modality) — they're a route label, not a
// per-condition identity. One color per condition for the condition-grouped view.
const CONDITION_COLORS: Record<string, string> = {
  auditory_on_object_intes: '#3b5bfd',
  auditory_on_person_intes: '#f79009',
  haptic_on_object_intes: '#12b76a',
  haptic_on_person_intes: '#d92d20',
};

interface Props {
  sessions: SessionRow[];
  sessionRows: CompareRow[];
  trialRows: TrialRow[];
  patientSummaries: PatientTrialSummary[];
  inclusion: Record<string, boolean>;
  dataLoading: boolean;
  excludedTrialOverrides: Record<string, boolean>;
  attemptChoices: Record<string, number>;
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function shortConditionLabel(condition: string): string {
  const modality = condition.startsWith('auditory') ? 'Aud' : condition.startsWith('haptic') ? 'Hap' : condition;
  const location = condition.includes('on_object') ? 'Obj' : condition.includes('on_person') ? 'Pers' : '';
  return `${modality}/${location}`;
}

function trialOverrideKey(patient: string, condition: string, pathId: string, explorationSessionId: number | null) {
  return `${patient}|${condition}|${pathId}|${explorationSessionId ?? 'none'}`;
}

/** Same key shape used for the shared attemptChoices map in App.tsx. */
function attemptChoiceKey(patient: string, condition: string, pathId: string, phase: string) {
  return `${patient}|${condition}|${pathId}|${phase}`;
}

const PATHS = ['path_A', 'path_B', 'path_C', 'path_D', 'path_E', 'path_F', 'path_G', 'path_H'];

// Standard protocol: each of the 4 conditions is run over 2 of the 8 paths,
// each path carrying 3 targets (O1/O2/O3) — i.e. 24 targets/patient total if
// every path in every condition were actually recorded and valid. Used only
// as a reference ceiling next to the real (uneven, exclusion-shrunk) counts
// below — not a claim that every patient/condition actually reaches it.
const PATHS_PER_CONDITION = 2;
const TARGETS_PER_PATH = 3;

/** Combined totals across every patient opted in via the "Include in General
 * statistics" checkbox on the Trial metrics tab (default: everyone included).
 * Reuses the same bulk session/trial data the Trial metrics tab fetches —
 * lifted to App so switching tabs doesn't re-trigger the slow bulk fetch. */
export function GeneralStatisticsPanel({ sessions, sessionRows, trialRows, patientSummaries, inclusion, dataLoading, excludedTrialOverrides, attemptChoices }: Props) {
  const patients = useMemo(() => uniq(sessions.map((s) => s.patient)), [sessions]);
  const includedPatients = useMemo(
    () => patients.filter((p) => inclusion[p] !== false),
    [patients, inclusion],
  );
  const includedSet = useMemo(() => new Set(includedPatients), [includedPatients]);

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

  // A trial flagged "exclude from statistics" (hardware error / bad trial)
  // must also drop its raw SESSIONS out of every session-level computation
  // below (Session totals, Fastest completion per path, etc.) — otherwise a
  // patient can mark a trial excluded and still see its numbers leak in here.
  const excludedSessionIds = useMemo(() => {
    const ids = new Set<number>();
    for (const r of effectiveTrialRows) {
      if (!r.excluded_from_stats) continue;
      if (r.learning_session_id != null) ids.add(r.learning_session_id);
      if (r.exploration_session_id != null) ids.add(r.exploration_session_id);
    }
    return ids;
  }, [effectiveTrialRows]);

  const includedSessionRows = useMemo(
    () => sessionRows.filter((r) =>
      includedSet.has(r.patient)
      && !excludedSessionIds.has(r.session_id)
      // A 0 s / 1-sample recording (backend already flags it "short/suspicious")
      // isn't a real attempt — without this a broken recording can win
      // "fastest completion" purely by having no duration at all.
      && (r.duration_s ?? 0) > 0
    ),
    [sessionRows, includedSet, excludedSessionIds],
  );

  // Deduplicate to one row per (patient, condition, path) — the most recent
  // non-excluded attempt — so a trial with retries doesn't inflate the
  // trial-level averages, and a flagged hardware-error attempt never counts.
  // If the researcher manually picked a specific exploration attempt in the
  // Trial metrics mini-card dropdown, that pick wins over "latest" here too
  // — the same trial should mean the same attempt everywhere in the app.
  const validTrialRows = useMemo(() => {
    const latest = new Map<string, TrialRow>();
    const chosen = new Map<string, TrialRow>();
    for (const r of includedAttempts) {
      const key = `${r.patient}|${r.condition}|${r.path_id}`;
      latest.set(key, r);
      const chosenId = attemptChoices[attemptChoiceKey(r.patient, r.condition, r.path_id, 'exploration')];
      if (chosenId !== undefined && r.exploration_session_id === chosenId) chosen.set(key, r);
    }
    for (const [key, row] of chosen) latest.set(key, row);
    return Array.from(latest.values());
  }, [includedAttempts, attemptChoices]);

  const attemptsLoaded = includedAttempts.length;

  const includedSummaries = useMemo(
    () => patientSummaries.filter((s) => includedSet.has(s.patient)),
    [patientSummaries, includedSet],
  );
  const lostTrials = sumBy(includedSummaries, 'lost_trials');
  const totalTrialsFromSummary = sumBy(includedSummaries, 'total_trials');

  const learningSessionRows = useMemo(() => includedSessionRows.filter((r) => r.phase === 'learning'), [includedSessionRows]);
  const explorationSessionRows = useMemo(() => includedSessionRows.filter((r) => r.phase === 'exploration'), [includedSessionRows]);

  /** Total + per-phase breakdown in one card, e.g. "182.4 m" with a
   * "Learning 91.2 m · Exploration 91.2 m" sub-line — grouped together
   * instead of three separate cards for the same underlying number. */
  function phaseBreakdown(fn: (rows: CompareRow[]) => number | null, decimals: number, unit: string) {
    return `Learning ${fmtNum(fn(learningSessionRows), decimals, unit)} · Exploration ${fmtNum(fn(explorationSessionRows), decimals, unit)}`;
  }

  const sessionItems = [
    { label: 'Patients included', value: `${includedPatients.length} / ${patients.length}`, icon: Users },
    { label: 'Sessions recorded', value: String(includedSessionRows.length), icon: ListChecks,
      sub: `Learning ${learningSessionRows.length} · Exploration ${explorationSessionRows.length}` },
    { label: 'Total duration', value: fmtNum(sumBy(includedSessionRows, 'duration_s') / 60, 1, ' min'), icon: Timer,
      sub: phaseBreakdown((rows) => sumBy(rows, 'duration_s') / 60, 1, ' min') },
    { label: 'Total feedback events', value: String(sumBy(includedSessionRows, 'feedback_events')), icon: Radio },
    { label: 'Total distance walked', value: fmtNum(sumBy(includedSessionRows, 'total_distance_m'), 1, ' m'), icon: Footprints,
      sub: phaseBreakdown((rows) => sumBy(rows, 'total_distance_m'), 1, ' m') },
    { label: 'Mean speed', value: fmtNum(avgBy(includedSessionRows, 'mean_speed_m_s'), 2, ' m/s'), icon: Gauge,
      sub: phaseBreakdown((rows) => avgBy(rows, 'mean_speed_m_s'), 2, ' m/s') },
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

  // "Completed" = returned to within the threshold of the exploration's OWN
  // start point (not the learning session's start) — empirically almost
  // identical (39 vs 41 of 134 valid attempts) but more robust: the reference
  // point always comes from a different recording (learning), so a broken/near-
  // empty exploration can never trivially "complete" just by having start==end.
  // Short/suspicious sessions (backend-flagged, e.g. 1-sample or a few-second
  // recording) are excluded from ever counting as completed even if duration>0,
  // since a near-empty recording can make self_return_distance_m trivially ~0.
  const suspiciousShortSessionIds = useMemo(
    () => new Set(sessions.filter((s) => s.is_suspicious_short).map((s) => s.session_id)),
    [sessions],
  );
  const completed = (r: TrialRow) =>
    r.self_return_distance_m != null
    && r.self_return_distance_m <= returnThreshold
    && !(r.exploration_session_id != null && suspiciousShortSessionIds.has(r.exploration_session_id));

  // Per-PATIENT outcome classification — every included patient lands in
  // exactly one bucket: the outcome they reached most often (the mode)
  // across their own trials, so the buckets always sum to the total number
  // of classifiable patients. This priority order both defines each trial's
  // category and breaks ties when a patient split evenly between two modes
  // (the better-ranked one wins): found more targets > in the
  // learning-taught order > completed (returned within the threshold).
  const OUTCOME_CATEGORIES: Array<{
    key: 'found3InOrderCompleted' | 'found3InOrderNotCompleted' | 'found3OutOfOrderCompleted' | 'found3OutOfOrderNotCompleted'
      | 'found2InOrderCompleted' | 'found2InOrderNotCompleted' | 'found2OutOfOrderCompleted' | 'found2OutOfOrderNotCompleted'
      | 'found1Completed' | 'found1NotCompleted' | 'found0Completed' | 'found0NotCompleted';
    label: string;
    test: (td: TargetDiscovery, isCompleted: boolean) => boolean;
  }> = [
    { key: 'found3InOrderCompleted', label: 'Found 3, in order & completed', test: (td, c) => td.found_count === 3 && td.in_order === true && c },
    { key: 'found3InOrderNotCompleted', label: 'Found 3, in order & not completed', test: (td, c) => td.found_count === 3 && td.in_order === true && !c },
    { key: 'found3OutOfOrderCompleted', label: 'Found 3, out of order & completed', test: (td, c) => td.found_count === 3 && td.in_order === false && c },
    { key: 'found3OutOfOrderNotCompleted', label: 'Found 3, out of order & not completed', test: (td, c) => td.found_count === 3 && td.in_order === false && !c },
    // found_count === 2 is the smallest count where "in order" is non-trivial
    // (2 targets can be found swapped) — found_count === 1 always trivially
    // reports in_order === true (nothing to be out of order relative to),
    // so that split only gets added here, not below.
    { key: 'found2InOrderCompleted', label: 'Found 2, in order & completed', test: (td, c) => td.found_count === 2 && td.in_order === true && c },
    { key: 'found2InOrderNotCompleted', label: 'Found 2, in order & not completed', test: (td, c) => td.found_count === 2 && td.in_order === true && !c },
    { key: 'found2OutOfOrderCompleted', label: 'Found 2, out of order & completed', test: (td, c) => td.found_count === 2 && td.in_order === false && c },
    { key: 'found2OutOfOrderNotCompleted', label: 'Found 2, out of order & not completed', test: (td, c) => td.found_count === 2 && td.in_order === false && !c },
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
    // Return-to-start, classified the same way (mode across the patient's own
    // trials, not their single best attempt) but independent of how many
    // targets were found — kept separate because "did they find the
    // targets" and "could they get back to the start" turned out to be two
    // different difficulties (very few patients land in the "returned" mode
    // at all, regardless of their found-count outcome).
    let returnedPatients = 0;
    let notReturnedPatients = 0;
    for (const [, rows] of trialsByPatient) {
      // Tally every trial into its category, then take the MODE (the
      // category this patient landed in most often across all their
      // trials) — a "best ever" pick made almost everyone show up under
      // "found 3" since most patients succeed at least once out of ~8
      // attempts, hiding that most of their individual trials don't.
      // Ties go to the better-ranked category (OUTCOME_CATEGORIES order).
      const tally = new Map<string, number>();
      let completedCount = 0;
      for (const r of rows) {
        const isCompleted = completed(r);
        if (isCompleted) completedCount += 1;
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
      // Ties (e.g. 2 of 4 trials completed) go to "returned" — same
      // better-outcome tie-break used for the found-count mode above.
      if (completedCount * 2 >= rows.length) returnedPatients += 1; else notReturnedPatients += 1;
    }
    return { counts, classifiedPatients: trialsByPatient.size, returnedPatients, notReturnedPatients };
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

  // One row per (patient, condition, path) valid trial — the per-trial detail
  // the aggregated buckets above deliberately hide (they classify each
  // PATIENT by their most common outcome, not each trial). Sorted by patient
  // so every trial for pp_X is grouped together, to answer "who completed what".
  const patientTrialDetail = useMemo(
    () => [...validTrialRows].sort((a, b) =>
      (a.patient ?? '').localeCompare(b.patient ?? '')
      || (a.condition ?? '').localeCompare(b.condition ?? '')
      || (a.path_id ?? '').localeCompare(b.path_id ?? '')),
    [validTrialRows],
  );

  const allConditions = useMemo(() => uniq(sessions.map((s) => s.condition)), [sessions]);

  // Patients with at least one valid trial in EVERY condition — e.g.
  // haptic_on_object_intes has been excluded/missing for several patients
  // (no O1/O2/O3 sensor, manual-coordinate fallback), which skews a raw
  // per-condition comparison: a condition with fewer contributing patients
  // isn't really being compared against the others, it's a different sample.
  // "Complete cases only" below restricts the comparison to patients present
  // in all conditions, so every bar in Success by condition reflects the
  // exact same group of people.
  const completeCasePatients = useMemo(() => {
    const conditionsByPatient = new Map<string, Set<string>>();
    for (const r of validTrialRows) {
      const set = conditionsByPatient.get(r.patient) ?? new Set<string>();
      set.add(r.condition);
      conditionsByPatient.set(r.patient, set);
    }
    const complete = new Set<string>();
    for (const [patient, conds] of conditionsByPatient) {
      if (allConditions.every((c) => conds.has(c))) complete.add(patient);
    }
    return complete;
  }, [validTrialRows, allConditions]);

  const [completeCasesOnly, setCompleteCasesOnly] = useState(false);
  // For "Copy as PNG" on the Success-by-condition table/chart — e.g. to
  // paste straight into a slide deck.
  const conditionTableRef = useRef<HTMLDivElement | null>(null);
  const conditionChartRef = useRef<HTMLDivElement | null>(null);

  // Per condition: how many valid trials found every target ("Found all
  // targets"), out of how many valid trials exist for that condition
  // ("Valid trials"), by how many distinct patients ("Patients").
  const conditionBreakdown = useMemo(() => {
    const patientUniverse = completeCasesOnly ? includedPatients.filter((p) => completeCasePatients.has(p)) : includedPatients;
    const rows = completeCasesOnly ? validTrialRows.filter((r) => completeCasePatients.has(r.patient)) : validTrialRows;
    // Same for every condition row (same patient universe, same protocol) —
    // shown per-row anyway so the shortfall from "everyone did every path"
    // is visible right next to that condition's actual numbers.
    const theoreticalMaxTrials = patientUniverse.length * PATHS_PER_CONDITION;
    const theoreticalMax = theoreticalMaxTrials * TARGETS_PER_PATH;
    const byCondition = new Map<string, { label: string; total: number; foundAll: number; patients: Set<string>; targetsFound: number; targetsPossible: number }>();
    for (const r of rows) {
      const entry = byCondition.get(r.condition) ?? { label: r.condition_label || r.condition, total: 0, foundAll: 0, patients: new Set<string>(), targetsFound: 0, targetsPossible: 0 };
      entry.total += 1;
      entry.patients.add(r.patient);
      if (r.target_discovery?.found_count === (r.target_discovery?.targets.length ?? -1) && (r.target_discovery?.targets.length ?? 0) > 0) {
        entry.foundAll += 1;
      }
      // Raw count of individual targets found, not trials — a trial that
      // found 2 of 3 contributes 2 here, not 0/1 the way foundAll does.
      entry.targetsFound += r.target_discovery?.found_count ?? 0;
      entry.targetsPossible += r.target_discovery?.targets.length ?? 0;
      byCondition.set(r.condition, entry);
    }
    // Iterate every known condition (not just ones with valid trials), so a
    // condition that's entirely missing/broken for everyone still shows a
    // (zeroed) row instead of silently disappearing from the table.
    return allConditions
      .map((condition) => {
        const entry = byCondition.get(condition);
        const label = entry?.label || sessions.find((s) => s.condition === condition)?.condition_label || condition;
        return {
          condition, label,
          total: entry?.total ?? 0,
          foundAll: entry?.foundAll ?? 0,
          patientCount: entry?.patients.size ?? 0,
          targetsFound: entry?.targetsFound ?? 0,
          targetsPossible: entry?.targetsPossible ?? 0,
          theoreticalMax,
          theoreticalMaxTrials,
        };
      })
      .sort((a, b) => a.condition.localeCompare(b.condition));
  }, [validTrialRows, sessions, includedPatients, allConditions, completeCasesOnly, completeCasePatients]);

  const conditionChartData = useMemo(
    () => conditionBreakdown.map((c) => ({
      name: c.label,
      successRate: c.total > 0 ? Math.round((100 * c.foundAll) / c.total) : 0,
    })),
    [conditionBreakdown],
  );

  const [chartDownloadState, setChartDownloadState] = useState<'idle' | 'loading' | 'error'>('idle');

  // Server-rendered (matplotlib) high-quality PNG — a downloadable
  // alternative to the "Copy chart" button below, which just screenshots the
  // live recharts SVG (fine for a quick paste, but styling/DPI can vary by
  // browser/zoom). This one renders identically every time.
  async function downloadConditionChartPng() {
    setChartDownloadState('loading');
    try {
      const blob = await fetchBarChartPng({
        title: 'Success by condition — Found all targets %',
        labels: conditionChartData.map((d) => d.name),
        values: conditionChartData.map((d) => d.successRate),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'success_by_condition.png';
      a.click();
      URL.revokeObjectURL(url);
      setChartDownloadState('idle');
    } catch {
      setChartDownloadState('error');
      setTimeout(() => setChartDownloadState('idle'), 1600);
    }
  }

  // Breakdown by (target, condition) — not just target — so it's visible
  // whether the escalation was confirmed under every feedback type/delivery
  // location or only some (e.g. barely at all under a condition whose
  // target tracking was broken, per compute_target_impacts' caveat below).
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
    // key: `${target_id}|${condition}`
    const counts = new Map<string, number>();
    if (closestZone != null) {
      for (const r of validTrialRows) {
        for (const t of r.target_discovery?.targets ?? []) {
          if (t.min_bucket === closestZone) {
            const key = `${t.target_id}|${r.condition}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
    }
    return { closestZone, counts };
  }, [validTrialRows]);

  // exploration_session_id -> duration_s, to time whichever single attempt
  // validTrialRows picked as each trial's representative (see below).
  const durationBySessionId = useMemo(
    () => new Map(includedSessionRows.map((r) => [r.session_id, r.duration_s])),
    [includedSessionRows],
  );

  // Per-path completion detail: ONE attempt per (patient, condition, path) —
  // the same deduplicated validTrialRows used everywhere else (latest attempt,
  // or the one manually chosen from the mini-card dropdown) — so a patient who
  // retried a path several times doesn't inflate the count over one who tried
  // it once. Ranked fastest → slowest, split into "completed" vs not, so it's
  // visible whether a path's completions are broadly spread or a one-off.
  const pathCompletion = useMemo(() => {
    return PATHS.map((pathId) => {
      const candidates = validTrialRows
        .filter((r) => r.path_id === pathId && r.exploration_session_id != null)
        .map((r) => ({
          patient: r.patient,
          durationS: durationBySessionId.get(r.exploration_session_id as number) ?? null,
          completed: completed(r),
        }))
        .filter((c): c is { patient: string; durationS: number; completed: boolean } => c.durationS != null && c.durationS > 0)
        .sort((a, b) => a.durationS - b.durationS);
      const completedList = candidates.filter((c) => c.completed);
      const pool = completedList.length ? completedList : candidates;
      const fastest = pool.length ? { patient: pool[0].patient, durationS: pool[0].durationS, completedOnly: completedList.length > 0 } : null;
      // Rough sanity-check reference, NOT a hard rule: with the standard
      // protocol (4 conditions × 2 paths = 8 trials/patient spread over the
      // 8 distinct path letters) a patient contributes ~1 trial per path.
      const patientCount = new Set(candidates.map((c) => c.patient)).size;
      // Mean/SD over every valid attempt (not just "completed") — "fastest"
      // above is a single best case, this is the actual spread of the path.
      const meanDurationS = avgBy(candidates, 'durationS');
      const stdDevDurationS = stdDevBy(candidates, 'durationS');
      return { pathId, totalAttempts: candidates.length, patientCount, expectedAttempts: includedPatients.length, completed: completedList, fastest, meanDurationS, stdDevDurationS };
    });
  }, [validTrialRows, durationBySessionId, includedPatients]);

  // Small-multiples "speed curve" data: rank 1..N on the x-axis, one line per
  // path — gaps (a path missing a point at some rank) are as informative as
  // the line itself, since they show exactly how many patients completed it.
  const completionCurveData = useMemo(() => {
    const maxRank = Math.max(0, ...pathCompletion.map((p) => p.completed.length));
    return Array.from({ length: maxRank }, (_, i) => {
      const row: Record<string, number | null | string> = { rank: i + 1 };
      for (const p of pathCompletion) {
        row[p.pathId] = p.completed[i] ? p.completed[i].durationS : null;
      }
      return row;
    });
  }, [pathCompletion]);

  // Same completion analysis as pathCompletion above, but grouped by the
  // actual experimental variable (condition = modality × delivery location)
  // instead of the path label — path_A..path_H are reused identically across
  // all 4 conditions, so grouping by path alone mixes different modalities
  // into one bucket and isn't a meaningful comparison.
  const conditionCompletion = useMemo(() => {
    const conditions = uniq(sessions.map((s) => s.condition));
    return conditions.map((condition) => {
      const label = sessions.find((s) => s.condition === condition)?.condition_label || condition;
      const candidates = validTrialRows
        .filter((r) => r.condition === condition && r.exploration_session_id != null)
        .map((r) => ({
          patient: r.patient,
          durationS: durationBySessionId.get(r.exploration_session_id as number) ?? null,
          completed: completed(r),
        }))
        .filter((c): c is { patient: string; durationS: number; completed: boolean } => c.durationS != null && c.durationS > 0)
        .sort((a, b) => a.durationS - b.durationS);
      const completedList = candidates.filter((c) => c.completed);
      const pool = completedList.length ? completedList : candidates;
      const fastest = pool.length ? { patient: pool[0].patient, durationS: pool[0].durationS, completedOnly: completedList.length > 0 } : null;
      // Sanity-check reference: standard protocol is 2 paths per condition,
      // so ~2 trials/patient is expected here (not a hard rule — patients
      // with only 1 path for a condition will fall short of it).
      const patientCount = new Set(candidates.map((c) => c.patient)).size;
      // Mean/SD over every valid attempt for this condition (across both its
      // paths) — the more meaningful grouping per the note that path_A..H are
      // reused across all 4 conditions, so this is the real experimental variable.
      const meanDurationS = avgBy(candidates, 'durationS');
      const stdDevDurationS = stdDevBy(candidates, 'durationS');
      return { condition, label, totalAttempts: candidates.length, patientCount, expectedAttempts: includedPatients.length * 2, completed: completedList, fastest, meanDurationS, stdDevDurationS };
    });
  }, [validTrialRows, durationBySessionId, sessions, includedPatients]);

  const completionCurveDataByCondition = useMemo(() => {
    const maxRank = Math.max(0, ...conditionCompletion.map((c) => c.completed.length));
    return Array.from({ length: maxRank }, (_, i) => {
      const row: Record<string, number | null | string> = { rank: i + 1 };
      for (const c of conditionCompletion) {
        row[c.condition] = c.completed[i] ? c.completed[i].durationS : null;
      }
      return row;
    });
  }, [conditionCompletion]);

  // Denominators shown as "N patients · M trials/attempts" context lines —
  // computed once here since several sections below (and the sections above)
  // share the same validTrialRows pool.
  const behavioralPatientCount = useMemo(() => new Set(validTrialRows.map((r) => r.patient)).size, [validTrialRows]);

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
                {item.sub ? <div className="metricSub">{item.sub}</div> : null}
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
          <InfoPopover>
            <h4>Why the mode, not the best trial?</h4>
            <p>With ~8 trials each, almost every patient succeeds at finding all 3 targets at least once — a "best ever" summary would put nearly everyone under "Found 3", hiding that most of an individual patient's trials may not find everything.</p>
            <p>Example: one patient's real trials were <strong>[2, 3, 1, 1, 1, 0]</strong> targets found — only 1 of 6 attempts found all 3, so they land under "Found 1", not "Found 3".</p>
            <p>Ties between categories are broken in favor of the better outcome.</p>
          </InfoPopover>). The categories below always sum to{' '}
          <strong>{discoveryBreakdown.classifiedPatients}</strong>, the number of patients with at least one comparable trial
          (out of {behavioralPatientCount} total valid patients — the rest have no trial with both learning and exploration data to compare).
        </p>

        <div className="outcomeGroup">
          <h4>Found all 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>In order &amp; completed</span><strong>{discoveryBreakdown.counts.found3InOrderCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>In order &amp; not completed</span><strong>{discoveryBreakdown.counts.found3InOrderNotCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>Out of order &amp; completed</span><strong>{discoveryBreakdown.counts.found3OutOfOrderCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>Out of order &amp; not completed</span><strong>{discoveryBreakdown.counts.found3OutOfOrderNotCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
          </div>
        </div>
        <div className="outcomeGroup">
          <h4>Found 2 of 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>In order &amp; completed</span><strong>{discoveryBreakdown.counts.found2InOrderCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>In order &amp; not completed</span><strong>{discoveryBreakdown.counts.found2InOrderNotCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>Out of order &amp; completed</span><strong>{discoveryBreakdown.counts.found2OutOfOrderCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>Out of order &amp; not completed</span><strong>{discoveryBreakdown.counts.found2OutOfOrderNotCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
          </div>
        </div>
        <div className="outcomeGroup">
          <h4>Found 1 of 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Completed</span><strong>{discoveryBreakdown.counts.found1Completed}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>Not completed</span><strong>{discoveryBreakdown.counts.found1NotCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
          </div>
        </div>
        <div className="outcomeGroup">
          <h4>Found 0 of 3 targets</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Completed</span><strong>{discoveryBreakdown.counts.found0Completed}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
            <div className="metricCard"><span>Not completed</span><strong>{discoveryBreakdown.counts.found0NotCompleted}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong></div>
          </div>
        </div>

        <div className="outcomeGroup">
          <h4>
            Return to start — independent of targets found
            <InfoPopover>
              <h4>Why is this separate from the found-target buckets?</h4>
              <p>Each found-target bucket above already splits into completed/not completed, but that hides the overall picture: a patient can find all 3 targets and still rarely make it back. This box classifies every patient by the SAME mode rule (most common outcome across their own trials, ties going to "returned"), just using only the completed/not-completed fact — regardless of how many targets that trial found.</p>
            </InfoPopover>
          </h4>
          <div className="metricGrid">
            <div className="metricCard">
              <span>Returned within {returnThreshold} m</span>
              <strong>{discoveryBreakdown.returnedPatients}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong>
            </div>
            <div className="metricCard">
              <span>Did not return within {returnThreshold} m</span>
              <strong>{discoveryBreakdown.notReturnedPatients}<span className="outOfTotal"> / {discoveryBreakdown.classifiedPatients}</span></strong>
            </div>
          </div>
        </div>

        <div className="outcomeGroup">
          <h4>Other (not part of the classification above — a patient can appear here and in one bucket above)</h4>
          <div className="metricGrid">
            <div className="metricCard"><span>Patients with ≥1 object impact</span><strong>{impactBreakdown.patientsWithImpact}<span className="outOfTotal"> / {behavioralPatientCount}</span></strong></div>
          </div>
        </div>

        <div className="behavioralSubgrid">
          <div className="behavioralSubcard span2">
            <h3>
              Trial outcomes by patient
              <InfoPopover>
                <h4>Why does this differ from the buckets above?</h4>
                <p>The Found/Return buckets above classify each PATIENT once, by their most common outcome across trials — useful for headline totals, but it hides which specific trial did what. This table is the raw per-trial detail behind those buckets: one row per (patient, condition, path) valid trial.</p>
              </InfoPopover>
            </h3>
            <p className="miniHint">{behavioralPatientCount} patients · {patientTrialDetail.length} trials.</p>
            <div className="tableWrap tall">
              <table className="miniTable">
                <thead><tr><th>Patient</th><th>Condition</th><th>Path</th><th>Targets found</th><th>Order</th><th>Completed</th></tr></thead>
                <tbody>
                  {patientTrialDetail.map((r) => {
                    const td = r.target_discovery;
                    const isCompleted = completed(r);
                    return (
                      <tr key={`${r.patient}|${r.condition}|${r.path_id}`}>
                        <td>{r.patient || '—'}</td>
                        <td>{r.condition ? shortConditionLabel(r.condition) : '—'}</td>
                        <td>{r.path_id ? r.path_id.replace('path_', '') : '—'}</td>
                        <td>{td ? `${td.found_count} / ${td.targets.length}` : '—'}</td>
                        <td>{!td || td.in_order == null ? '—' : td.in_order ? 'In order' : 'Out of order'}</td>
                        <td>{isCompleted ? <span className="okBadge">Yes</span> : <span className="warningBadge">No</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="behavioralSubcard span2">
            <h3>
              Success by condition
              <InfoPopover>
                <h4>Success by condition — column definitions</h4>
                <p>For each of the 4 conditions (modality × delivery location):</p>
                <ul>
                  <li><strong>Found all targets</strong> — valid trials where every placed target got at least one feedback event.</li>
                  <li><strong>Targets collected</strong> — raw count of individual targets found (a 2-of-3 trial contributes 2, not 0), out of every target placed under that condition <em>that was actually recorded and valid</em> (targets possible) — not out of the protocol ceiling.</li>
                  <li><strong>Theoretical max</strong> — targets possible (same numerator as above) out of patients shown × 2 paths × 3 targets, i.e. what targets possible WOULD be if every patient had a valid trial on every path of that condition. The gap between numerator and denominator is exactly the missing/excluded-trial shortfall (path never recorded, hardware error, etc.).</li>
                  <li><strong>Valid trials</strong> — total trials run under that condition (the denominator for the columns above) out of patients shown × 2 paths, i.e. how many trials there WOULD be if every patient had a valid trial on every path of that condition.</li>
                  <li><strong>Patients</strong> — how many distinct patients contributed at least one of those trials.</li>
                </ul>
              </InfoPopover>
            </h3>
            <label className="inlineCheck" title="Restricts every row below to only patients who have at least one valid trial in ALL 4 conditions — so a condition with more exclusions (e.g. haptic_on_object_intes) is compared against the exact same group of people, not a larger/different one.">
              <input
                type="checkbox"
                checked={completeCasesOnly}
                onChange={(e) => setCompleteCasesOnly(e.target.checked)}
              />
              Complete cases only ({completeCasePatients.size} / {includedPatients.length} patients have valid data in all {allConditions.length} conditions)
            </label>
            <p className="miniHint">
              {completeCasesOnly ? completeCasePatients.size : behavioralPatientCount} patients · {conditionBreakdown.reduce((a, c) => a + c.total, 0)} trials analyzed.
            </p>
            <div className="copyPngRow">
              <CopyAsPngButton targetRef={conditionTableRef} label="Copy table" />
            </div>
            <div className="tableWrap" ref={conditionTableRef}>
              <table className="miniTable">
                <thead><tr><th>Condition</th><th>Found all targets</th><th>Targets collected</th><th>Theoretical max</th><th>Valid trials</th><th>Patients</th></tr></thead>
                <tbody>
                  {conditionBreakdown.map((c) => (
                    <tr key={c.condition}>
                      <td>{c.label}</td><td>{c.foundAll} / {c.total}</td><td>{c.targetsFound} / {c.targetsPossible}</td>
                      <td>{c.targetsPossible} / {c.theoreticalMax}</td>
                      <td>{c.total} / {c.theoreticalMaxTrials}</td><td>{c.patientCount}</td>
                    </tr>
                  ))}
                  <tr>
                    <td><strong>Total</strong></td>
                    <td><strong>{sumBy(conditionBreakdown, 'foundAll')} / {sumBy(conditionBreakdown, 'total')}</strong></td>
                    <td><strong>{sumBy(conditionBreakdown, 'targetsFound')} / {sumBy(conditionBreakdown, 'targetsPossible')}</strong></td>
                    <td><strong>{sumBy(conditionBreakdown, 'targetsPossible')} / {sumBy(conditionBreakdown, 'theoreticalMax')}</strong></td>
                    <td><strong>{sumBy(conditionBreakdown, 'total')} / {sumBy(conditionBreakdown, 'theoreticalMaxTrials')}</strong></td>
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="copyPngRow">
              <CopyAsPngButton targetRef={conditionChartRef} label="Copy chart" />
              <button
                type="button"
                className="copyPngBtn"
                onClick={downloadConditionChartPng}
                disabled={chartDownloadState === 'loading'}
                title="Download a server-rendered, presentation-quality PNG of this chart (matplotlib) — consistent styling regardless of browser/zoom"
              >
                <FileDown size={13} />
                {chartDownloadState === 'loading' ? 'Rendering…' : chartDownloadState === 'error' ? 'Failed' : 'Download chart (PNG)'}
              </button>
            </div>
            <div ref={conditionChartRef}>
              <ChartFrame height={220} minWidth={260}>{(width, height) => (
                <BarChart width={width} height={height} data={conditionChartData} margin={{ top: 12, right: 12, bottom: 48, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" angle={-25} textAnchor="end" interval={0} height={60} tick={{ fontSize: 10 }} />
                  <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 10 }} />
                  <Tooltip
                    animationDuration={0}
                    isAnimationActive={false}
                    formatter={(v: unknown) => typeof v === 'number' ? `${v}%` : '—'}
                  />
                  <Bar dataKey="successRate" name="Found all targets" isAnimationActive={false} radius={[6, 6, 0, 0]}>
                    {conditionChartData.map((d) => <Cell key={d.name} fill={accent} />)}
                  </Bar>
                </BarChart>
              )}</ChartFrame>
            </div>
          </div>

          <div className="behavioralSubcard span2">
            <h3>Proximity escalation confirmed</h3>
            <p className="miniHint">{behavioralPatientCount} patients · {validTrialRows.length} trials analyzed. Trials (by target × condition) where that target reached the closest proximity zone observed (bucket {proximityBreakdown.closestZone ?? '—'}).</p>
            <div className="tableWrap">
              <table className="miniTable">
                <thead>
                  <tr>
                    <th>Target</th>
                    {conditionBreakdown.map((c) => <th key={c.condition} title={c.label}>{shortConditionLabel(c.condition)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {['O1', 'O2', 'O3'].map((tid) => (
                    <tr key={tid}>
                      <td>{tid}</td>
                      {conditionBreakdown.map((c) => (
                        <td key={c.condition}>{proximityBreakdown.counts.get(`${tid}|${c.condition}`) ?? 0}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="behavioralSubcard">
            <h3>Object impacts by target</h3>
            <p className="miniHint">{behavioralPatientCount} patients · {validTrialRows.length} trials analyzed. Counts are impact events, not trials — one trial can register more than one.</p>
            <div className="tableWrap">
              <table className="miniTable">
                <thead><tr><th>Target</th><th>Impact count</th></tr></thead>
                <tbody>
                  {['O1', 'O2', 'O3'].map((tid) => (
                    <tr key={tid}><td>{tid}</td><td>{impactBreakdown.perTarget[tid] ?? 0}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="behavioralSubcard span2">
            <h3>Fastest completion per path</h3>
            <p className="miniHint">
              {behavioralPatientCount} patients · {validTrialRows.length} trials considered — one attempt per (patient, condition, path): the latest, or the one manually chosen from the mini-card dropdown, never a raw count inflated by retries.
              "Completed" = returned to the exploration's own start point within the threshold above. Order below is fastest → slowest among the completed trials only.
              "Trials" in parentheses is a rough expected count (~1 per included patient per path, from the 4 conditions × 2 paths protocol) — not a hard rule, just a quick check for whether a path's total looks low (missing patients).
            </p>
            <div className="tableWrap">
              <table className="miniTable">
                <thead><tr><th>Path</th><th>Fastest</th><th>Mean ± SD</th><th>Completed</th><th>Order (fastest → slowest)</th></tr></thead>
                <tbody>
                  {pathCompletion.map((p) => (
                    <tr key={p.pathId}>
                      <td><span className="pathDot" style={{ background: PATH_COLORS[p.pathId] }} />{p.pathId.replace('path_', '')}</td>
                      <td>
                        {p.fastest ? fmtNum(p.fastest.durationS, 0, ' s') : '—'}
                        {p.fastest && !p.fastest.completedOnly ? ' (no completed attempt)' : ''}
                      </td>
                      <td>{fmtNum(p.meanDurationS, 0, ' s')}{p.stdDevDurationS != null ? ` ± ${fmtNum(p.stdDevDurationS, 0, ' s')}` : ''}</td>
                      <td>{p.completed.length}/{p.totalAttempts} <span className="miniHintInline">({p.patientCount} pts, ~{p.expectedAttempts} expected)</span></td>
                      <td className="completionOrderCell">
                        {p.completed.length
                          ? p.completed.map((c, i) => `${i + 1}. ${c.patient} (${fmtNum(c.durationS, 0, 's')})`).join('  ')
                          : <em>none</em>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ChartFrame height={260} minWidth={320}>{(width, height) => (
              <LineChart width={width} height={height} data={completionCurveData} margin={{ top: 12, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="rank" tick={{ fontSize: 10 }} label={{ value: 'Completion rank (1st fastest, 2nd, ...)', position: 'insideBottom', offset: -4, fontSize: 10 }} />
                <YAxis unit="s" tick={{ fontSize: 10 }} />
                <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(0)} s` : '—')} />
                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => value.replace('path_', '')} />
                {PATHS.map((pathId) => (
                  <Line
                    key={pathId}
                    type="monotone"
                    dataKey={pathId}
                    name={pathId}
                    stroke={PATH_COLORS[pathId]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}</ChartFrame>
            <p className="miniHint">Each line is one path: point N is the Nth-fastest completed attempt for that path. A short/missing line (e.g. path B) means few or no patients actually completed it — not that no one tried.</p>
          </div>

          <div className="behavioralSubcard span2">
            <h3>
              Fastest completion per condition
              <InfoPopover>
                <p>path_A..path_H are reused identically across all 4 conditions (every path letter appears under every modality) — they're a route label, not a per-condition identity.</p>
                <p>Grouping by condition instead compares the actual experimental variable: feedback modality (auditory/haptic) × delivery location (on object/on person).</p>
              </InfoPopover>
            </h3>
            <p className="miniHint">
              {behavioralPatientCount} patients · {validTrialRows.length} trials considered — one attempt per (patient, condition, path), across both paths of each condition.
              Same "completed" definition as above; order is fastest → slowest among completed trials only.
              "Trials" in parentheses is a rough expected count (~2 per included patient per condition, from the "2 paths per condition" protocol) — not a hard rule, just a quick check for missing patients.
            </p>
            <div className="tableWrap">
              <table className="miniTable">
                <thead><tr><th>Condition</th><th>Fastest</th><th>Mean ± SD</th><th>Completed</th><th>Order (fastest → slowest)</th></tr></thead>
                <tbody>
                  {conditionCompletion.map((c) => (
                    <tr key={c.condition}>
                      <td><span className="pathDot" style={{ background: CONDITION_COLORS[c.condition] ?? '#888' }} />{c.label}</td>
                      <td>
                        {c.fastest ? fmtNum(c.fastest.durationS, 0, ' s') : '—'}
                        {c.fastest && !c.fastest.completedOnly ? ' (no completed attempt)' : ''}
                      </td>
                      <td>{fmtNum(c.meanDurationS, 0, ' s')}{c.stdDevDurationS != null ? ` ± ${fmtNum(c.stdDevDurationS, 0, ' s')}` : ''}</td>
                      <td>{c.completed.length}/{c.totalAttempts} <span className="miniHintInline">({c.patientCount} pts, ~{c.expectedAttempts} expected)</span></td>
                      <td className="completionOrderCell">
                        {c.completed.length
                          ? c.completed.map((r, i) => `${i + 1}. ${r.patient} (${fmtNum(r.durationS, 0, 's')})`).join('  ')
                          : <em>none</em>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ChartFrame height={260} minWidth={320}>{(width, height) => (
              <LineChart width={width} height={height} data={completionCurveDataByCondition} margin={{ top: 12, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="rank" tick={{ fontSize: 10 }} label={{ value: 'Completion rank (1st fastest, 2nd, ...)', position: 'insideBottom', offset: -4, fontSize: 10 }} />
                <YAxis unit="s" tick={{ fontSize: 10 }} />
                <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(0)} s` : '—')} />
                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => shortConditionLabel(value)} />
                {conditionCompletion.map((c) => (
                  <Line
                    key={c.condition}
                    type="monotone"
                    dataKey={c.condition}
                    name={c.condition}
                    stroke={CONDITION_COLORS[c.condition] ?? '#888'}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}</ChartFrame>
          </div>
        </div>
      </section>
    </>
  );
}
