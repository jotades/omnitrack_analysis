import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUp, FileDown, Flag, LayoutGrid, Lock, MapPin, Network, NotebookPen, RefreshCw, Sigma, Target, Undo2, Users, Workflow, X,
  type LucideIcon,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnovaDvResult, AnovaResults, CompareRow, PatientTrialSummary, SessionRow, TargetDiscovery, TrialRow } from '../types';
import { fetchAnovaResults, fetchBarChartPng, fetchObservations, fetchStatsExclusions, onDerivedCachesInvalidated, saveObservation } from '../api';
import { avgBy, fmtNum, maxBy, stdDevBy, sumBy } from '../lib/aggregate';
import { ChartFrame } from './ChartFrame';
import { CopyAsPngButton, InfoPopover, Tex } from './InfoPopover';
import { routeLabel } from '../lib/route';
import { conditionLabel, conditionShort, participantLabel } from '../lib/glossary';

const accent = '#3b5bfd';
// path_A..path_H are reused across ALL 4 conditions (verified: every path
// letter appears under every modality) — they're a route label, not a
// per-condition identity. One color per condition for the condition-grouped view.
// Hue = modality (blue auditory, orange haptic), lightness = location (dark on object, light on person).
const CONDITION_COLORS: Record<string, string> = {
  auditory_on_object_intes: '#2f47d9',
  auditory_on_person_intes: '#8093ff',
  haptic_on_object_intes: '#b54708',
  haptic_on_person_intes: '#f79009',
};

// Two-line caption under each ANOVA bar chart, keyed by the DV's backend
// key (see ANOVA_DV_SPECS in analysis.py) — what's actually plotted (one
// bar = mean across the complete-case patients' per-patient average over
// that condition's 2 paths) and how to read higher vs. lower bars.
const DV_CHART_DESCRIPTIONS: Record<string, string> = {
  endpoint_error_m: 'Each bar: mean distance between the point E marked on the exploration recording and the point E marked on the learning recording. Lower means the participant stopped closer to the taught end point.',
  target_acquisition_pct: 'Each bar: mean fraction of the route’s O1–O3 landmarks actually found (feedback- or distance-confirmed). Higher means more landmarks located per trial.',
  target_within_05m_pct: 'Each bar: mean share of the route\u2019s three landmarks reached within 0.5 m during the first task (closest distance of the hand-held unit to each landmark unit; haptic external: the manual found flag, the patches being 50 cm across). A stricter version of landmark acquisition, which uses 1.0 m.',
  performance_score: 'Each bar: mean 1–5 heuristic composite (endpoint + landmark proximity + landmarks reached + border crossings). Higher means better overall task performance under that condition.',
  dtw_distance_m: 'Each bar: mean DTW distance between the learning and the exploration route, each cut at its marked point E and resampled to 100 points. Lower means the route walked from memory was closer to the taught one.',
  exploration_task1_length_m: 'Each bar: mean length walked on the horizontal plane from the start of the exploration recording to the marked point E.',
  exploration_task1_duration_s: 'Each bar: mean time from the start of the exploration recording to the marked point E.',
  exploration_task1_speed_m_s: 'Each bar: mean walking speed during the first task (length ÷ duration).',
  exploration_task1_length_change_m: 'Each bar: mean change in task-1 trajectory length from the learning phase: experimental length minus learning length of the same trial. Positive = the route walked from memory was longer than the guided one.',
  exploration_task1_movement_intensity_m_s2: 'Each bar: mean movement intensity during the first task — how much the hand-held unit was being moved (sweeping, turning, hesitating), as the average size of its linear acceleration.',
  exploration_task2_movement_intensity_m_s2: 'Each bar: mean movement intensity during the second task (the walk back) — how much the hand-held unit was being moved, as the average size of its linear acceleration.',
  exploration_task1_pause_duration_s: 'Each bar: mean time spent standing still during the first task (stay points: the hand-held unit staying within 0.141 m, its position error, for at least 1 s; data gaps left out), all pauses added together.',
  exploration_task2_pause_duration_s: 'Each bar: mean time spent standing still during the second task (the walk back) (stay points: the hand-held unit staying within 0.141 m, its position error, for at least 1 s; data gaps left out), all pauses added together.',
  exploration_task1_border_reached_count: 'Each bar: mean number of border crossings during the first task. A crossing starts when the hand-held unit is more than 0.141 m (its position error) outside the centred safety box, and the next one only after it has come back more than 0.141 m inside, so jitter near the border is not counted many times. Lower means the participant stayed inside the field. Many trials have none: read the box plot and the rank-test line too.',
  exploration_task2_border_reached_count: 'Each bar: mean number of border crossings during the second task (the walk back). A crossing starts when the hand-held unit is more than 0.141 m (its position error) outside the centred safety box, and the next one only after it has come back more than 0.141 m inside, so jitter near the border is not counted many times. Lower means the participant stayed inside the field. Many trials have none: read the box plot and the rank-test line too.',
  exploration_task1_approach_depth_pct: 'Each bar: mean of how far into a landmark’s feedback the participant went during the first task. The feedback gets stronger in steps as the landmark gets closer: 0% = never went past the first step, 100% = reached the strongest one. Only landmarks that gave feedback count.',
  return_to_start_distance_m: 'Each bar: mean distance between the last position of the exploration recording and the first position of the learning recording (the taught starting point S). Lower means the walk back ended closer to S.',
  dtw_task2_distance_m: 'Each bar: mean DTW distance between the two walks back, each cut from its marked point E to the end of the recording. The two walks start from different points E, so this also carries the end-point error of the first task.',
  exploration_task2_length_m: 'Each bar: mean length walked on the horizontal plane from the marked point E to the end of the exploration recording.',
  exploration_task2_duration_s: 'Each bar: mean time from the marked point E to the end of the exploration recording.',
  exploration_task2_speed_m_s: 'Each bar: mean walking speed during the second task (length ÷ duration).',
  exploration_task2_length_change_m: 'Each bar: mean change in task-2 (walk back) trajectory length from the learning phase: experimental length minus learning length of the same trial. Positive = the walk back from memory was longer than the guided one.',
};
const MIXED_MODEL_ROWS: Array<{ key: 'modality' | 'location' | 'interaction'; label: string; hint: string; levels?: [string, string] }> = [
  { key: 'modality', label: 'Haptic − auditory', levels: ['Haptic', 'Auditory'], hint: 'Difference between haptic and auditory trials, averaged over the two signal locations.' },
  { key: 'location', label: 'On person − external', levels: ['On person', 'External'], hint: 'Difference between on-person and external trials, averaged over the two modalities.' },
  { key: 'interaction', label: 'Interaction', hint: 'How much the haptic − auditory difference changes between on person and external. Close to 0 = the two factors act independently.' },
];

// Task 1 / Task 2 measures with no "better" direction: the conditions with the
// lowest and the highest mean get these labels, the way "Best" marks the others.
const DV_EXTREME_LABELS: Array<{ suffix: string; low: string; high: string }> = [
  { suffix: '_length_m', low: 'Shortest', high: 'Longest' },
  { suffix: '_duration_s', low: 'Shortest', high: 'Longest' },
  { suffix: '_speed_m_s', low: 'Slowest', high: 'Fastest' },
  { suffix: '_approach_depth_pct', low: 'Farthest', high: 'Closest' },
  { suffix: '_movement_intensity_m_s2', low: 'Least movement', high: 'Most movement' },
];

// Groups of the two participant-count charts under Approach depth, ordered
// from the strongest to the weakest outcome (one hue, dark to light; the
// first one sits at the bottom of the bar). `reading` completes the sentence
// "N participants …" in the example under the chart.
type ParticipantGroup = { key: string; label: string; reading: string; color: string; labelColor: string };
const APPROACH_GROUPS: ParticipantGroup[] = [
  { key: 'full', label: 'Participants who went all the way in, every time', reading: 'went all the way in on every landmark', color: '#4a2fb0', labelColor: '#ffffff' },
  { key: 'partway', label: 'Participants who stopped halfway at least once', reading: 'stopped halfway at least once', color: '#9b86e0', labelColor: '#101828' },
  { key: 'turned', label: 'Participants who turned back at the first signal at least once', reading: 'turned back at the first signal at least once', color: '#d9d1f5', labelColor: '#101828' },
];
const REACH_GROUPS: ParticipantGroup[] = [
  { key: 'none', label: 'Participants who found every landmark', reading: 'found every landmark', color: '#4a2fb0', labelColor: '#ffffff' },
  { key: 'one', label: 'Participants who missed 1 landmark', reading: 'missed one', color: '#9b86e0', labelColor: '#101828' },
  { key: 'more', label: 'Participants who missed 2 or more landmarks', reading: 'missed two or more', color: '#d9d1f5', labelColor: '#101828' },
];

// Approach depth has a section of its own: it is about how the feedback was
// used, not about the route.
const APPROACH_DV = 'exploration_task1_approach_depth_pct';

const DV_GROUPS: Array<{ key: 'task1' | 'task2' | 'whole'; title: string; subtitle: string }> = [
  { key: 'task1', title: 'First task', subtitle: 'from the starting point S to the end point E (marked)' },
  { key: 'task2', title: 'Second task', subtitle: 'back from the end point E to the starting point S' },
  { key: 'whole', title: 'Landmarks and whole recording', subtitle: 'first task for the landmarks' },
];

type CategoryKey = 'overview' | 'conditions' | 'anova' | 'task1' | 'approach' | 'task2' | 'landmarks' | 'flow' | 'mixed' | 'notes';
/** Which participants a section counts: the Participants switch, the ANOVA
 * sample, the mixed model's, or none (notes). */
type SampleKind = 'switch' | 'anova' | 'mixed' | 'none';
/** tone = colour (ten: the ANOVA sample, all: every participant shown, mixed:
 * the mixed model); fixed = does not follow the Participants switch. */
type SampleTag = { tone: 'ten' | 'all' | 'mixed' | 'none'; label: string; fixed: boolean };

// Sections of the tab, in reading order, opened and closed from the panel on the left.
const CATEGORIES: Array<{ key: CategoryKey; title: string; hint: string; sample: SampleKind; icon: LucideIcon }> = [
  { key: 'overview', title: 'Overview', hint: 'Sessions, trials and who is in the sample', sample: 'switch', icon: Users },
  { key: 'conditions', title: 'By condition', hint: 'Landmarks found, route shape, duration and contacts per condition', sample: 'switch', icon: LayoutGrid },
  { key: 'anova', title: 'ANOVA summary', hint: 'p values of every measure, and how the test works', sample: 'anova', icon: Sigma },
  { key: 'task1', title: 'First task', hint: 'From the starting point S to the end point E (marked)', sample: 'anova', icon: Flag },
  { key: 'approach', title: 'Approach depth', hint: 'First task: how far into each landmark’s feedback the participant went', sample: 'anova', icon: Target },
  { key: 'landmarks', title: 'Landmarks', hint: 'First task: landmarks reached within 1.0 m and within 0.5 m', sample: 'anova', icon: MapPin },
  { key: 'task2', title: 'Second task', hint: 'Back from the end point E to the starting point S', sample: 'anova', icon: Undo2 },
  { key: 'flow', title: 'Trial flow', hint: 'Where trials end up: landmarks found, end point, return to start', sample: 'switch', icon: Workflow },
  { key: 'mixed', title: 'Mixed model', hint: 'Main measures trial by trial, also for participants with a condition missing', sample: 'mixed', icon: Network },
  { key: 'notes', title: 'Notes', hint: 'Your observations', sample: 'none', icon: NotebookPen },
];
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c])) as Record<CategoryKey, (typeof CATEGORIES)[number]>;

// The three steps the panel on the left walks through: describe the data,
// test the conditions, look closer. Sub-sections belong to the first task.
const CATEGORY_GROUPS: Array<{ key: string; title: string; hint: string; items: CategoryKey[] }> = [
  { key: 'describe', title: 'Describe the data', hint: 'Who took part and what happened in the trials', items: ['overview', 'conditions'] },
  { key: 'test', title: 'Test the conditions', hint: 'ANOVA: does the modality or the location change the result?', items: ['anova', 'task1', 'approach', 'landmarks', 'task2'] },
  { key: 'closer', title: 'Look closer', hint: 'Trial by trial, and your notes', items: ['flow', 'mixed', 'notes'] },
];
const SUB_CATEGORIES = new Set<CategoryKey>(['approach', 'landmarks']);
const OPEN_CATEGORIES_KEY = 'omnitrack.generalStats.openSections';
const DEFAULT_OPEN: CategoryKey[] = ['overview', 'anova'];

/** Sections left open last time in this browser, or the default ones. */
function loadOpenCategories(): Set<CategoryKey> {
  try {
    const raw = localStorage.getItem(OPEN_CATEGORIES_KEY);
    const keys: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(keys)) return new Set(CATEGORIES.map((c) => c.key).filter((k) => keys.includes(k)));
  } catch { /* storage unavailable: use the default */ }
  return new Set(DEFAULT_OPEN);
}

/** Section holding an ANOVA measure's card. */
function categoryOfDv(dv: AnovaDvResult): CategoryKey {
  if (dv.dv === APPROACH_DV) return 'approach';
  return dv.group === 'task1' ? 'task1' : dv.group === 'task2' ? 'task2' : 'landmarks';
}

/** "frozen position: P1 position unchanged ... during 55% of ..." -> "Frozen position (55% of the time)". */
function shortExclusionReason(why: string): string {
  const kind = why.split(':')[0].trim();
  const pct = why.match(/(\d+)% of its recorded time/)?.[1];
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}${pct ? ` (${pct}% of the time)` : ''}`;
}

const BOX_PLOT_READING = 'Line in the box: median. Box: the middle half of the participants (a tall box = participants differ a lot). Dashed line: mean (when it sits far from the median, a few extreme values are pulling it). Whiskers: the other usual values. Each dot is one participant; hover a dot to see who, hover the box for its numbers. An empty dot far from the box is an unusual case.';

// Measure shown in the Route shape chart (one at a time, picked above it).
const QUALITY_CHARTS = [
  { key: 'shapeDeviationM', label: 'Shape dev', unit: ' m' },
  { key: 'frechetDistanceM', label: 'Fréchet', unit: ' m' },
  { key: 'overlapPct', label: 'Overlap', unit: '%' },
] as const;

// Which direction counts as "better" for each DV — drives the "Higher/Lower
// is better" badge and which condition gets highlighted as the best-mean one.
const DV_BETTER_DIRECTION: Record<string, 'higher' | 'lower'> = {
  endpoint_error_m: 'lower',
  target_acquisition_pct: 'higher',
  target_within_05m_pct: 'higher',
  performance_score: 'higher',
  dtw_distance_m: 'lower',
  return_to_start_distance_m: 'lower',
  dtw_task2_distance_m: 'lower',
  exploration_task1_border_reached_count: 'lower',
  exploration_task2_border_reached_count: 'lower',
};

// Same LaTeX already shown for these measures in Trial metrics (see
// ConditionTrajectoriesGrid.tsx) — reused verbatim here so the two tabs
// never risk disagreeing on how a number is actually computed.
const DV_FORMULA: Partial<Record<string, string>> = {
  target_acquisition_pct: String.raw`\text{Landmarks reached} \% = 100 \times \dfrac{\text{landmarks reached}}{\text{landmarks total}}`,
  endpoint_error_m: String.raw`\text{End-point distance} = \left\lVert E^{exploration} - E^{learning} \right\rVert`,
  return_to_start_distance_m: String.raw`\text{Return distance} = \left\lVert p_{last}^{exploration} - S^{learning} \right\rVert`,
  // W = the DTW pairing of the two routes (each resampled to n points) with the smallest total distance.
  dtw_distance_m: String.raw`\text{DTW} = \dfrac{1}{n} \min_{W} \sum_{(i,j) \in W} \left\lVert L_i - X_j \right\rVert`,
  dtw_task2_distance_m: String.raw`\text{DTW} = \dfrac{1}{n} \min_{W} \sum_{(i,j) \in W} \left\lVert L_i - X_j \right\rVert`,
  exploration_task1_length_m: String.raw`\text{Length} = \sum_{t_i < t_E} \left\lVert p_{i+1} - p_i \right\rVert_{xy}`,
  exploration_task2_length_m: String.raw`\text{Length} = \sum_{t_i \ge t_E} \left\lVert p_{i+1} - p_i \right\rVert_{xy}`,
  exploration_task1_duration_s: String.raw`\text{Duration} = t_E - t_{start}`,
  exploration_task2_duration_s: String.raw`\text{Duration} = t_{end} - t_E`,
  exploration_task1_speed_m_s: String.raw`\text{Speed} = \dfrac{\text{Length}}{\text{Duration}}`,
  exploration_task1_length_change_m: String.raw`\Delta L = L^{exploration}_{S \to E} - L^{learning}_{S \to E}`,
  exploration_task2_length_change_m: String.raw`\Delta L = L^{exploration}_{E \to S} - L^{learning}_{E \to S}`,
  exploration_task1_movement_intensity_m_s2: String.raw`\text{Movement} = \dfrac{1}{n} \sum_{t_i < t_E,\ a_i > 0} \lVert a_i \rVert`,
  exploration_task2_movement_intensity_m_s2: String.raw`\text{Movement} = \dfrac{1}{n} \sum_{t_i \ge t_E,\ a_i > 0} \lVert a_i \rVert`,
  exploration_task1_pause_duration_s: String.raw`\text{Stopped} = \sum_{\text{pauses}} \left( t_{end} - t_{start} \right)`,
  exploration_task2_pause_duration_s: String.raw`\text{Stopped} = \sum_{\text{pauses}} \left( t_{end} - t_{start} \right)`,
  exploration_task1_border_reached_count: String.raw`\text{Crossings} = \#\,\text{exits before } t_E`,
  exploration_task2_border_reached_count: String.raw`\text{Crossings} = \#\,\text{exits after } t_E`,
  exploration_task1_approach_depth_pct: String.raw`\text{Depth} = 100 \times \dfrac{\text{steps crossed after the first}}{\text{steps available}}`,
  exploration_task2_speed_m_s: String.raw`\text{Speed} = \dfrac{\text{Length}}{\text{Duration}}`,
};

// Unit each DV's Mean ± SD is reported in — shown in the table header and
// appended to each cell, since "Mean ± SD" alone doesn't say whether that's
// %, meters, or the unitless 1-5 composite scale.
const DV_UNIT_LABEL: Record<string, string> = {
  endpoint_error_m: 'm',
  target_acquisition_pct: '%',
  target_within_05m_pct: '%',
  performance_score: '1–5 scale',
  dtw_distance_m: 'm', return_to_start_distance_m: 'm', dtw_task2_distance_m: 'm',
  exploration_task1_length_m: 'm', exploration_task2_length_m: 'm',
  exploration_task1_duration_s: 's', exploration_task2_duration_s: 's',
  exploration_task1_speed_m_s: 'm/s', exploration_task2_speed_m_s: 'm/s',
  exploration_task1_length_change_m: 'm', exploration_task2_length_change_m: 'm',
  exploration_task1_approach_depth_pct: '%',
  exploration_task1_movement_intensity_m_s2: 'm/s²', exploration_task2_movement_intensity_m_s2: 'm/s²', exploration_task1_pause_duration_s: 's', exploration_task2_pause_duration_s: 's',
};
const DV_VALUE_SUFFIX: Record<string, string> = {
  endpoint_error_m: ' m',
  target_acquisition_pct: '%',
  target_within_05m_pct: '%',
  performance_score: '/5',
  dtw_distance_m: ' m', return_to_start_distance_m: ' m', dtw_task2_distance_m: ' m',
  exploration_task1_length_m: ' m', exploration_task2_length_m: ' m',
  exploration_task1_duration_s: ' s', exploration_task2_duration_s: ' s',
  exploration_task1_speed_m_s: ' m/s', exploration_task2_speed_m_s: ' m/s',
  exploration_task1_length_change_m: ' m', exploration_task2_length_change_m: ' m',
  exploration_task1_movement_intensity_m_s2: ' m/s²', exploration_task2_movement_intensity_m_s2: ' m/s²', exploration_task1_pause_duration_s: ' s', exploration_task2_pause_duration_s: ' s',
  exploration_task1_approach_depth_pct: '%',
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

/** AP / AE / HP / HE, as in the thesis. */
function shortConditionLabel(condition: string): string {
  return conditionShort(condition);
}

function trialOverrideKey(patient: string, condition: string, pathId: string, explorationSessionId: number | null) {
  return `${patient}|${condition}|${pathId}|${explorationSessionId ?? 'none'}`;
}

/** Same key shape used for the shared attemptChoices map in App.tsx. */
function attemptChoiceKey(patient: string, condition: string, pathId: string, phase: string) {
  return `${patient}|${condition}|${pathId}|${phase}`;
}

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
  // below (Session totals, duration by condition, etc.) — otherwise a
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
    // A recording fixed by hand on the backend (recording_pins.json) wins over
    // a pick made in this browser, so these numbers match the ANOVA's.
    const pinned = new Set(includedAttempts.filter((r) => r.exploration_pinned).map((r) => `${r.patient}|${r.condition}|${r.path_id}`));
    for (const [key, row] of chosen) if (!pinned.has(key)) latest.set(key, row);
    return Array.from(latest.values());
  }, [includedAttempts, attemptChoices]);

  const allConditions = useMemo(() => uniq(sessions.map((s) => s.condition)), [sessions]);

  // Patients with at least one valid trial in EVERY condition — e.g.
  // haptic_on_object_intes has been excluded/missing for several patients
  // (no O1/O2/O3 sensor, manual-coordinate fallback), which skews a raw
  // per-condition comparison: a condition with fewer contributing patients
  // isn't really being compared against the others, it's a different sample.
  // "Complete cases only" below restricts several comparisons to patients
  // present in all conditions, so they reflect the exact same group of people.
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

  const [completeCasesOnly, setCompleteCasesOnly] = useState(true);

  // Dataset-wide ANOVA (Modality x Location, subject=patient) — same
  // singleton-promise-cached fetch as fetchPerformanceCorrelations, computed
  // server-side since it needs every trial's navigation metrics regardless
  // of which patients/conditions happen to be in view here. Also re-fetches
  // itself whenever a save elsewhere (annotation, target coordinate,
  // discovery override, patient inclusion, /api/refresh) invalidates the
  // underlying data — see onDerivedCachesInvalidated in api.ts — so editing
  // O1/O2/O3 or excluding a trial in Trial metrics updates this card right
  // away, without a full page reload or a manual "Refresh" click.
  const [anovaResults, setAnovaResults] = useState<AnovaResults | null>(null);
  const [anovaError, setAnovaError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchAnovaResults()
        .then((r) => { if (!cancelled) setAnovaResults(r); })
        .catch((err) => { if (!cancelled) setAnovaError(err instanceof Error ? err.message : String(err)); });
    };
    load();
    const unsubscribe = onDerivedCachesInvalidated(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // Which columns of "Route shape by condition" to show — hiding one here
  // also hides it from the "Copy table" PNG export, since that just
  // rasterizes whatever is actually rendered in qualityTableRef.
  const [qualityColumnsVisible, setQualityColumnsVisible] = useState({
    shapeDev: true, frechet: true, overlap: true, n: true,
  });
  const toggleQualityColumn = (key: keyof typeof qualityColumnsVisible) =>
    setQualityColumnsVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  const [qualityChartKey, setQualityChartKey] = useState<(typeof QUALITY_CHARTS)[number]['key']>('shapeDeviationM');

  // Participants left out of the statistics for data quality (pilot, frozen
  // position). Fetched on its own: the ANOVA can take minutes to arrive.
  const [statsExclusions, setStatsExclusions] = useState<Record<string, string> | null>(null);
  useEffect(() => { fetchStatsExclusions().then(setStatsExclusions).catch(() => setStatsExclusions({})); }, []);

  // The ANOVA participants: a valid trial in every condition and not left out
  // for data quality. Until the ANOVA has loaded, the same rule computed here.
  const completeSet = useMemo(() => {
    if (anovaResults?.complete_participants) return new Set(anovaResults.complete_participants);
    const excluded = anovaResults?.excluded_participants ?? statsExclusions ?? {};
    return new Set([...completeCasePatients].filter((p) => !(p in excluded)));
  }, [anovaResults, statsExclusions, completeCasePatients]);
  // The numbers above are not final while the trials are still loading.
  const countsReady = validTrialRows.length > 0 && (statsExclusions != null || anovaResults != null);
  const completeCount = useMemo(() => includedPatients.filter((p) => completeSet.has(p)).length, [includedPatients, completeSet]);

  // One switch for the whole tab (the bar under the header): every table and
  // chart below uses these participants, except the ANOVA and the mixed model.
  const patientUniverse = useMemo(
    () => (completeCasesOnly ? includedPatients.filter((p) => completeSet.has(p)) : includedPatients),
    [completeCasesOnly, includedPatients, completeSet],
  );
  const universeSet = useMemo(() => new Set(patientUniverse), [patientUniverse]);
  const filteredValidTrialRows = useMemo(
    () => validTrialRows.filter((r) => universeSet.has(r.patient)),
    [validTrialRows, universeSet],
  );
  const sampleSessionRows = useMemo(
    () => includedSessionRows.filter((r) => universeSet.has(r.patient)),
    [includedSessionRows, universeSet],
  );

  const attemptsLoaded = includedAttempts.filter((r) => universeSet.has(r.patient)).length;

  const includedSummaries = useMemo(
    () => patientSummaries.filter((s) => universeSet.has(s.patient)),
    [patientSummaries, universeSet],
  );
  const lostTrials = sumBy(includedSummaries, 'lost_trials');
  const totalTrialsFromSummary = sumBy(includedSummaries, 'total_trials');

  const learningSessionRows = useMemo(() => sampleSessionRows.filter((r) => r.phase === 'learning'), [sampleSessionRows]);
  const explorationSessionRows = useMemo(() => sampleSessionRows.filter((r) => r.phase === 'exploration'), [sampleSessionRows]);

  // Sessions card: one row per measure, Learning | Exploration | Total.
  const sessionTableRows: Array<{ label: string; value: (rows: CompareRow[]) => string }> = [
    { label: 'Sessions', value: (rows) => String(rows.length) },
    { label: 'Duration', value: (rows) => fmtNum(sumBy(rows, 'duration_s') / 60, 1, ' min') },
    { label: 'Distance walked', value: (rows) => fmtNum(sumBy(rows, 'total_distance_m'), 1, ' m') },
    { label: 'Mean speed', value: (rows) => fmtNum(avgBy(rows, 'mean_speed_m_s'), 2, ' m/s') },
    { label: 'Feedback events', value: (rows) => String(sumBy(rows, 'feedback_events')) },
    { label: 'Max acceleration', value: (rows) => fmtNum(maxBy(rows, 'max_accel_norm'), 2) },
  ];

  const trialItems = [
    { label: 'Valid trials (one per participant, condition and route)', value: String(filteredValidTrialRows.length) },
    { label: 'Attempts loaded', value: String(attemptsLoaded) },
    { label: 'Trials lost or disrupted', value: `${lostTrials} / ${totalTrialsFromSummary}` },
    { label: 'Mean route overlap', value: fmtNum(avgBy(filteredValidTrialRows, 'overlap_pct'), 0, '%') },
    { label: 'Mean stop-position difference', value: fmtNum(avgBy(filteredValidTrialRows, 'stop_position_distance_m'), 2, ' m') },
    { label: 'Mean start-position difference', value: fmtNum(avgBy(filteredValidTrialRows, 'start_position_distance_m'), 2, ' m') },
    { label: 'Pauses (total)', value: String(sumBy(filteredValidTrialRows, 'exploration_pause_count')) },
    { label: 'Border crossings (total)', value: String(sumBy(filteredValidTrialRows, 'border_reached_count')) },
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
    for (const r of filteredValidTrialRows) {
      const values = Object.values(r.target_impacts ?? {});
      if (values.some((v) => v > 0)) patientsWithImpact.add(r.patient);
      for (const [tid, count] of Object.entries(r.target_impacts ?? {})) {
        perTarget[tid] = (perTarget[tid] ?? 0) + count;
      }
    }
    return { patientsWithImpact: patientsWithImpact.size, perTarget };
  }, [filteredValidTrialRows]);

  // One row per (patient, condition, path) valid trial — the per-trial detail
  // the aggregated buckets above deliberately hide (they classify each
  // PATIENT by their most common outcome, not each trial). Sorted by patient
  // so every trial for pp_X is grouped together, to answer "who completed what".
  const patientTrialDetail = useMemo(
    () => [...filteredValidTrialRows].sort((a, b) =>
      (a.patient ?? '').localeCompare(b.patient ?? '')
      || (a.condition ?? '').localeCompare(b.condition ?? '')
      || (a.path_id ?? '').localeCompare(b.path_id ?? '')),
    [filteredValidTrialRows],
  );

  // For "Copy as PNG" on the Success-by-condition table/chart — e.g. to
  // paste straight into a slide deck.
  const conditionTableRef = useRef<HTMLDivElement | null>(null);
  const conditionChartRef = useRef<HTMLDivElement | null>(null);
  const qualityTableRef = useRef<HTMLDivElement | null>(null);
  const shapeDeviationChartRef = useRef<HTMLDivElement | null>(null);
  const durationTableRef = useRef<HTMLDivElement | null>(null);
  const durationChartRef = useRef<HTMLDivElement | null>(null);

  // Per condition: how many valid trials found every target ("Found all
  // targets"), out of how many valid trials exist for that condition
  // ("Valid trials"), by how many distinct patients ("Patients").
  const conditionBreakdown = useMemo(() => {
    const rows = filteredValidTrialRows;
    // Same for every condition row (same patient universe, same protocol) —
    // shown per-row anyway so the shortfall from "everyone did every path"
    // is visible right next to that condition's actual numbers.
    const theoreticalMaxTrials = patientUniverse.length * PATHS_PER_CONDITION;
    const theoreticalMax = theoreticalMaxTrials * TARGETS_PER_PATH;
    const byCondition = new Map<string, { label: string; total: number; foundAll: number; patients: Set<string>; targetsFound: number; targetsPossible: number }>();
    for (const r of rows) {
      const entry = byCondition.get(r.condition) ?? { label: conditionLabel(r.condition), total: 0, foundAll: 0, patients: new Set<string>(), targetsFound: 0, targetsPossible: 0 };
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
        const label = conditionLabel(condition);
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
  }, [filteredValidTrialRows, sessions, allConditions, patientUniverse]);

  // Route-shape quality per condition — mean of the same three trial-level
  // metrics shown on each Trial metrics mini-card (Shape overlap section:
  // Overlap, Shape dev, Fréchet), averaged over filteredValidTrialRows so it
  // reacts to "Complete cases only" the same way Success by condition does.
  const conditionQualityBreakdown = useMemo(() => {
    const conditions = uniq(sessions.map((s) => s.condition));
    return conditions.map((condition) => {
      const rows = filteredValidTrialRows.filter((r) => r.condition === condition);
      const label = conditionLabel(condition);
      return {
        condition,
        label,
        n: rows.length,
        shapeDeviationM: avgBy(rows, 'shape_deviation_m'),
        frechetDistanceM: avgBy(rows, 'frechet_distance_m'),
        overlapPct: avgBy(rows, 'overlap_pct'),
      };
    });
  }, [filteredValidTrialRows, sessions]);

  // Best/worst per column, to flag the standout condition the same way this
  // was reported manually — lower is better for the two distance metrics,
  // higher is better for overlap. Skips columns with no data at all.
  const qualityExtremes = useMemo(() => {
    const pick = (key: 'shapeDeviationM' | 'frechetDistanceM' | 'overlapPct', want: 'min' | 'max') => {
      const withValue = conditionQualityBreakdown.filter((c) => c[key] != null) as Array<typeof conditionQualityBreakdown[number] & Record<typeof key, number>>;
      if (!withValue.length) return null;
      return withValue.reduce((best, c) => (want === 'min' ? c[key] < best[key] : c[key] > best[key]) ? c : best).condition;
    };
    return {
      shapeDeviationBest: pick('shapeDeviationM', 'min'),
      shapeDeviationWorst: pick('shapeDeviationM', 'max'),
      frechetWorst: pick('frechetDistanceM', 'max'),
      overlapWorst: pick('overlapPct', 'min'),
    };
  }, [conditionQualityBreakdown]);

  // Three separate mini bar charts rather than one grouped chart — shape dev
  // and Fréchet are in meters, overlap is a percentage, so a single shared
  // y-axis would misrepresent them.
  const qualityChartData = useMemo(
    () => conditionQualityBreakdown.map((c) => ({
      condition: c.condition,
      name: shortConditionLabel(c.condition),
      shapeDeviationM: c.shapeDeviationM ?? 0,
      frechetDistanceM: c.frechetDistanceM ?? 0,
      overlapPct: c.overlapPct ?? 0,
    })),
    [conditionQualityBreakdown],
  );

  const conditionChartData = useMemo(
    () => conditionBreakdown.map((c) => ({
      condition: c.condition,
      name: shortConditionLabel(c.condition),
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
        title: 'Success by condition — Found all landmarks %',
        labels: conditionChartData.map((d) => d.name),
        values: conditionChartData.map((d) => d.successRate),
        color: accent,
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
    for (const r of filteredValidTrialRows) {
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
      for (const r of filteredValidTrialRows) {
        for (const t of r.target_discovery?.targets ?? []) {
          if (t.min_bucket === closestZone) {
            const key = `${t.target_id}|${r.condition}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
    }
    return { closestZone, counts };
  }, [filteredValidTrialRows]);

  // exploration_session_id -> duration_s, to time whichever single attempt
  // validTrialRows picked as each trial's representative (see below).
  const durationBySessionId = useMemo(
    () => new Map(includedSessionRows.map((r) => [r.session_id, r.duration_s])),
    [includedSessionRows],
  );

  // Completion (fastest/mean duration) per condition — the actual
  // experimental variable (condition = modality × delivery location).
  // path_A..path_H are reused identically across all 4 conditions, so
  // grouping by path alone would mix different modalities into one bucket.
  const conditionCompletion = useMemo(() => {
    const conditions = uniq(sessions.map((s) => s.condition));
    return conditions.map((condition) => {
      const label = conditionLabel(condition);
      const candidates = filteredValidTrialRows
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
      // Same trials' LEARNING recordings, as a reference point: was the
      // exploration attempt faster/slower than the route just taught?
      const learningCandidates = filteredValidTrialRows
        .filter((r) => r.condition === condition && r.learning_session_id != null)
        .map((r) => ({ durationS: durationBySessionId.get(r.learning_session_id as number) ?? null }))
        .filter((c): c is { durationS: number } => c.durationS != null && c.durationS > 0);
      const meanLearningDurationS = avgBy(learningCandidates, 'durationS');
      const stdDevLearningDurationS = stdDevBy(learningCandidates, 'durationS');
      return {
        condition, label, totalAttempts: candidates.length, patientCount, expectedAttempts: patientUniverse.length * 2,
        completed: completedList, fastest, meanDurationS, stdDevDurationS, meanLearningDurationS, stdDevLearningDurationS,
      };
    });
  }, [filteredValidTrialRows, durationBySessionId, sessions, patientUniverse]);

  // Shortest/longest mean duration among conditions — reuses conditionCompletion's
  // meanDurationS rather than recomputing it, for the compact duration-by-condition table.
  const durationExtremes = useMemo((): { shortest: string | null; longest: string | null; shortestS: number | null; longestS: number | null } => {
    const withValue = conditionCompletion.filter((c): c is typeof c & { meanDurationS: number } => c.meanDurationS != null);
    if (!withValue.length) return { shortest: null, longest: null, shortestS: null, longestS: null };
    const shortest = withValue.reduce((best, c) => (c.meanDurationS < best.meanDurationS ? c : best));
    const longest = withValue.reduce((best, c) => (c.meanDurationS > best.meanDurationS ? c : best));
    return { shortest: shortest.condition, longest: longest.condition, shortestS: shortest.meanDurationS, longestS: longest.meanDurationS };
  }, [conditionCompletion]);

  const durationChartData = useMemo(
    () => conditionCompletion.map((c) => ({ condition: c.condition, name: shortConditionLabel(c.condition), meanDurationS: c.meanDurationS ?? 0 })),
    [conditionCompletion],
  );

  // Denominator of the "N participants · M trials" lines under each card.
  const behavioralPatientCount = useMemo(() => new Set(filteredValidTrialRows.map((r) => r.patient)).size, [filteredValidTrialRows]);

  // ---------------------------------------------------------------------
  // Layout: sections opened from the bar at the top, each one a grid of
  // equal cards. The colour of a card says which participants it counts.
  // ---------------------------------------------------------------------
  const [openCats, setOpenCats] = useState<Set<CategoryKey>>(loadOpenCategories);
  useEffect(() => {
    try { localStorage.setItem(OPEN_CATEGORIES_KEY, JSON.stringify([...openCats])); } catch { /* storage unavailable */ }
  }, [openCats]);
  // Element to bring into view once the section holding it has rendered.
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingScroll.current;
    if (!id) return;
    pendingScroll.current = null;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const openSection = (key: CategoryKey, targetId = `cat-${key}`) => {
    pendingScroll.current = targetId;
    setOpenCats((prev) => new Set(prev).add(key));
  };
  const setSectionOpen = (key: CategoryKey, open: boolean) => setOpenCats((prev) => {
    const next = new Set(prev);
    if (open) next.add(key); else next.delete(key);
    return next;
  });
  const allOpen = openCats.size === CATEGORIES.length;
  // Open section at the top of the screen, marked in the panel on the left.
  const [activeCat, setActiveCat] = useState<CategoryKey | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: CategoryKey | null = null;
      for (const c of CATEGORIES) {
        if (!openCats.has(c.key)) continue;
        const el = document.getElementById(`cat-${c.key}`);
        if (!el || !el.offsetParent) continue;
        if (current === null || el.getBoundingClientRect().top <= 120) current = c.key;
      }
      setActiveCat(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [openCats]);
  const pickDv = (dv: AnovaDvResult) => openSection(categoryOfDv(dv), `dv-${dv.dv}`);

  const mixedN = anovaResults?.mixed_models?.find((m) => !m.insufficient_data)?.n_patients ?? null;
  const switchTag: SampleTag = { tone: completeCasesOnly ? 'ten' : 'all', label: `${patientUniverse.length} participants`, fixed: false };
  const anovaTag = (n: number): SampleTag => ({ tone: 'ten', label: `${n} participants`, fixed: true });
  const tagOf = (kind: SampleKind): SampleTag | null => (
    kind === 'switch' ? switchTag
      : kind === 'anova' ? anovaTag(completeCount)
        : kind === 'mixed' ? { tone: 'mixed', label: mixedN != null ? `${mixedN} participants` : 'participants', fixed: true }
          : null
  );

  // Who is in the sample: one row per participant shown in this tab.
  const participantRows = useMemo(() => includedPatients.map((p) => {
    const own = validTrialRows.filter((r) => r.patient === p);
    const conditions = new Set(own.map((r) => r.condition));
    const missing = allConditions.filter((c) => !conditions.has(c));
    const why = anovaResults?.excluded_participants?.[p];
    const status = completeSet.has(p) ? null
      : why ? shortExclusionReason(why)
        : missing.length ? `Missing ${missing.map(shortConditionLabel).join(', ')}` : 'Not in the ANOVA';
    return { patient: p, trials: own.length, conditions, inTen: completeSet.has(p), status };
  }), [includedPatients, validTrialRows, allConditions, anovaResults, completeSet]);
  const excludedList = Object.entries(anovaResults?.excluded_participants ?? {})
    .map(([p, why]) => `${participantLabel(p)} (${shortExclusionReason(why).toLowerCase()})`).join(', ');

  const renderDvCard = (dv: AnovaDvResult, part: 'full' | 'main' | 'box' = 'full') => {
    const groupKey = dv.group ?? 'whole';
    const groupTitle = DV_GROUPS.find((g) => g.key === groupKey)?.title ?? '';
    const tag = anovaTag(dv.n_patients);
    const direction = DV_BETTER_DIRECTION[dv.dv];
    const directionBadge = direction && part !== 'box' ? (
      <span className={`betterDirectionBadge ${direction}`} title={direction === 'higher' ? 'A higher value is the better outcome for this measure' : 'A lower value is the better outcome for this measure'}>
        {direction === 'higher' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
        {direction === 'higher' ? 'Higher is better' : 'Lower is better'}
      </span>
    ) : null;
    if (dv.insufficient_data) {
      return (
        <StatsCard key={`${dv.dv}-${part}`} id={part === 'box' ? undefined : `dv-${dv.dv}`} title={dv.label} tag={tag} extra={directionBadge}>
          <p className="miniHint">
            Not enough complete-case data for a balanced 2×2 test — {dv.n_patients} participant(s) with a usable value in all 4 conditions (need at least 4).
            {dv.error ? ` (${dv.error})` : ''}
          </p>
        </StatsCard>
      );
    }
    const boxPlot = dv.cell_values ? (
      <CopyableChart title={`${groupTitle} · ${dv.label}`}>
        <ChartFrame height={240} minWidth={220}>{(width, height) => (
          <BoxPlot width={width} height={height} conditions={dv.conditions} values={dv.cell_values!} />
        )}</ChartFrame>
      </CopyableChart>
    ) : null;
    if (part === 'box') {
      return (
        <StatsCard key={`${dv.dv}-box`} title={`${dv.label}: one dot per participant`} tag={tag}>
          {boxPlot}
          <p className="miniHint">{BOX_PLOT_READING}</p>
        </StatsCard>
      );
    }
    const barData = dv.conditions.map((c) => ({
      condition: c,
      label: shortConditionLabel(c),
      mean: dv.cell_means?.[c]?.mean ?? null,
    }));
    // A condition is singled out (Best, Fastest, Closest...) only when
    // at least one effect of the test has p < 0.05: otherwise the
    // highest mean is not evidence that the condition is better.
    const anySignificant = !!dv.effects && Object.values(dv.effects).some((e) => e && e.p < 0.05);
    // Which condition has the best mean for this DV — null when
    // there's nothing to compare. Ties just highlight the first one.
    const bestCondition = direction && anySignificant
      ? dv.conditions.reduce<string | null>((best, c) => {
          const mean = dv.cell_means?.[c]?.mean;
          if (mean == null) return best;
          const bestMean = best ? dv.cell_means?.[best]?.mean : null;
          if (bestMean == null) return c;
          return direction === 'higher' ? (mean > bestMean ? c : best) : (mean < bestMean ? c : best);
        }, null)
      : null;
    // Lowest / highest mean of a task length, duration or speed.
    const extremeLabels = groupKey === 'whole' || !anySignificant ? undefined : DV_EXTREME_LABELS.find((l) => dv.dv.endsWith(l.suffix));
    const withMean = extremeLabels ? dv.conditions.filter((c) => dv.cell_means?.[c]?.mean != null) : [];
    const meanOf = (c: string) => dv.cell_means?.[c]?.mean as number;
    const lowCondition = withMean.length > 1 ? withMean.reduce((best, c) => (meanOf(c) < meanOf(best) ? c : best)) : null;
    const highCondition = withMean.length > 1 ? withMean.reduce((best, c) => (meanOf(c) > meanOf(best) ? c : best)) : null;
    return (
      <StatsCard key={dv.dv} id={`dv-${dv.dv}`} title={dv.label} tag={tag} extra={directionBadge}>
        <div className="dvFormula">
          {DV_FORMULA[dv.dv] ? (
            <>
              <Tex tex={DV_FORMULA[dv.dv] as string} displayMode={false} />
              {dv.dv.startsWith('dtw_') ? <span className="miniHintInline">L = learning route, X = exploration route, W = best pairing of their points.</span> : null}
              {dv.dv === APPROACH_DV ? <span className="miniHintInline">One step = one change of the feedback (every 0.2 m), from where it starts to its strongest level at 0.6 m. HE: read from the participant’s position against the protocol position of the route’s landmarks, since only P1 is tracked there.</span> : null}
            </>
          ) : null}
        </div>
        <div className="tableWrap">
          <table className="miniTable">
            <thead><tr><th>Condition</th><th>{dv.learning_cell_means ? 'Exploration' : 'Mean ± SD'}{DV_UNIT_LABEL[dv.dv] ? ` (${DV_UNIT_LABEL[dv.dv]})` : ''}</th>{dv.learning_cell_means ? <th title="Same measure on the learning recording of the same trials — reference only, not part of the test">Learning</th> : null}{dv.learning_cell_means ? <th title="Percent change of the exploration value against the learning value, computed trial by trial: 100 × (exploration − learning) ÷ learning. Reference only, not part of the test">vs learning</th> : null}<th>n</th></tr></thead>
            <tbody>
              {dv.conditions.map((c) => {
                const cm = dv.cell_means?.[c];
                const isBest = c === bestCondition;
                const extremeLabel = lowCondition === highCondition ? null : c === lowCondition ? extremeLabels?.low : c === highCondition ? extremeLabels?.high : null;
                const unitSuffix = DV_VALUE_SUFFIX[dv.dv] ?? '';
                const lm = dv.learning_cell_means?.[c];
                const ch = lm?.change_pct_mean;
                return (
                  <tr key={c} className={isBest || extremeLabel ? 'bestRow' : undefined}>
                    <td><span className="pathDot" style={{ background: CONDITION_COLORS[c] ?? '#888' }} />{shortConditionLabel(c)}{isBest ? <span className="bestBadge" title="Best mean for this measure">Best</span> : null}{extremeLabel ? <span className="bestBadge extreme" title={`${extremeLabel} mean across the conditions`}>{extremeLabel}</span> : null}</td>
                    <td>{cm ? `${fmtNum(cm.mean, 2)}${cm.sd != null ? ` ± ${fmtNum(cm.sd, 2)}` : ''}${unitSuffix}` : '—'}</td>
                    {dv.learning_cell_means ? (
                      <>
                        <td className="miniHintInline">{lm?.mean != null ? `${fmtNum(lm.mean, 2)}${lm.sd != null ? ` ± ${fmtNum(lm.sd, 2)}` : ''}${unitSuffix}` : '—'}</td>
                        <td>{ch != null ? `${ch > 0 ? '+' : ''}${fmtNum(ch, 0)}%${lm?.change_pct_sd != null ? ` ± ${fmtNum(lm.change_pct_sd, 0)}` : ''}` : '—'}</td>
                      </>
                    ) : null}
                    <td>{cm?.n ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <CopyableChart title={`${groupTitle} · ${dv.label}`}>
          <ChartFrame height={200} minWidth={220}>{(width, height) => (
            <BarChart width={width} height={height} data={barData} margin={{ top: 12, right: 12, bottom: 32, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => (typeof v === 'number' ? fmtNum(v, 2) : '—')} />
              <Bar dataKey="mean" isAnimationActive={false} radius={[6, 6, 0, 0]}>
                {barData.map((b) => (
                  <Cell
                    key={b.condition}
                    fill={CONDITION_COLORS[b.condition] ?? '#888'}
                    stroke={b.condition === bestCondition ? 'var(--ink)' : 'none'}
                    strokeWidth={b.condition === bestCondition ? 2 : 0}
                  />
                ))}
              </Bar>
            </BarChart>
          )}</ChartFrame>
        </CopyableChart>
        <p className="miniHint">
          {DV_CHART_DESCRIPTIONS[dv.dv]}
          {dv.rank_effects ? ` Rank-transformed ANOVA (robustness check): modality p = ${fmtNum(dv.rank_effects.modality.p, 3)}, location p = ${fmtNum(dv.rank_effects.location.p, 3)}, interaction p = ${fmtNum(dv.rank_effects.interaction.p, 3)}.` : ''}
        </p>
        {part === 'full' ? boxPlot : null}
        {part === 'full' && boxPlot ? <p className="miniHint">Box plot of the same data: one dot per participant.</p> : null}
      </StatsCard>
    );
  };

  const anovaPending = (title: string) => (
    <StatsCard key="pending" title={anovaError ? 'Could not load the ANOVA' : anovaResults ? title : 'Loading the ANOVA…'} tag={null}>
      <p className="miniHint">{anovaError ?? (anovaResults ? 'No result for this section.' : 'The tests are computed on the server; the first time this can take a few minutes.')}</p>
    </StatsCard>
  );
  const dvsOf = (group: 'task1' | 'task2' | 'whole') => (anovaResults?.dvs ?? []).filter((dv) => (dv.group ?? 'whole') === group && dv.dv !== APPROACH_DV);
  const glanceCard = (title: string, dvs: AnovaDvResult[]) => (
    <StatsCard
      key="glance"
      className="glance"
      title={`${title} at a glance`}
      tag={anovaTag(completeCount)}
      info={<p>Mean of every measure of this section per condition, and which effects of the ANOVA have p &lt; 0.05. Click a measure to go to its card, with SD, learning values, bars and box plot.</p>}
    >
      <div className="glanceBody">
        <GlanceTable dvs={dvs} onPick={pickDv} />
      </div>
    </StatsCard>
  );

  const sessionsCard = (
    <StatsCard
      key="sessions"
      title="Sessions"
      tag={switchTag}
      info={<p>Every recorded session, learning and exploration, of the selected participants. Sessions of trials marked “exclude from statistics” and empty recordings (0 s) are left out.</p>}
    >
      <p className="miniHint">{patientUniverse.length} of {patients.length} participants · {sampleSessionRows.length} sessions</p>
      <div className="tableWrap">
        <table className="miniTable statsNumberTable">
          <thead><tr><th>Measure</th><th>Learning</th><th>Exploration</th><th>Total</th></tr></thead>
          <tbody>
            {sessionTableRows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.value(learningSessionRows)}</td>
                <td>{row.value(explorationSessionRows)}</td>
                <td><strong>{row.value(sampleSessionRows)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </StatsCard>
  );

  const trialsCard = (
    <StatsCard
      key="trials"
      title="Trials"
      tag={switchTag}
      info={<p>One trial per participant, condition and route: the latest attempt not excluded from statistics, or the attempt picked in Trial metrics.</p>}
    >
      <p className="miniHint">{behavioralPatientCount} participants · {filteredValidTrialRows.length} trials</p>
      <div className="tableWrap">
        <table className="miniTable statsNumberTable">
          <tbody>
            {trialItems.map((item) => (
              <tr key={item.label}><td>{item.label}</td><td>{item.value}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </StatsCard>
  );

  const participantsCard = (
    <StatsCard
      key="participants"
      title="Who is in the sample"
      tag={{ tone: 'all', label: `${includedPatients.length} participants`, fixed: true }}
      info={<p>Every participant shown in General statistics. The {completeCount} marked in teal have a valid trial in all four conditions and no data-quality problem: they are the ANOVA sample and the default of the Participants switch.</p>}
    >
      <p className="miniHint">
        {completeCount} of {includedPatients.length} participants are in the ANOVA sample
        {patients.length > includedPatients.length ? `; ${patients.length - includedPatients.length} hidden with “Show in General statistics”` : ''}.
      </p>
      <div className="tableWrap tall">
        <table className="miniTable participantSampleTable">
          <thead><tr><th>Participant</th>{allConditions.map((c) => <th key={c}>{shortConditionLabel(c)}</th>)}<th>Trials</th><th>Sample</th></tr></thead>
          <tbody>
            {participantRows.map((row) => (
              <tr key={row.patient} className={row.inTen ? 'inSample' : undefined}>
                <td>{participantLabel(row.patient)}</td>
                {allConditions.map((c) => <td key={c}>{row.conditions.has(c) ? '✓' : '—'}</td>)}
                <td>{row.trials}</td>
                <td>{row.inTen ? <span className="sampleChip tone-ten"><span className="sampleDot" />In the {completeCount}</span> : <span className="miniHintInline">{row.status}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </StatsCard>
  );

  const outcomesCard = (
    <StatsCard
      key="outcomes"
      title="Trial outcomes by participant"
      tag={switchTag}
      info={<p>One row per valid trial (participant × condition × route): landmarks reached, their order, whether the participant came back within {returnThreshold} m of the start, and whether point E is marked on both recordings.</p>}
    >
      <p className="miniHint">{behavioralPatientCount} participants · {patientTrialDetail.length} trials</p>
      <div className="tableWrap tall">
        <table className="miniTable">
          <thead><tr><th>Participant</th><th>Condition</th><th>Route</th><th>Landmarks reached</th><th>Order</th><th>Completed</th><th title="Point E marked on the exploration recording">E exploration</th><th title="Point E marked on the learning recording">E learning</th></tr></thead>
          <tbody>
            {patientTrialDetail.map((r) => {
              const td = r.target_discovery;
              const isCompleted = completed(r);
              return (
                <tr key={`${r.patient}|${r.condition}|${r.path_id}`}>
                  <td>{participantLabel(r.patient)}</td>
                  <td>{r.condition ? shortConditionLabel(r.condition) : '—'}</td>
                  <td>{routeLabel(r.path_id, r.route_id)}</td>
                  <td>{td ? `${td.found_count} / ${td.targets.length}` : '—'}</td>
                  <td>{!td || td.in_order == null ? '—' : td.in_order ? 'In order' : 'Out of order'}</td>
                  <td>{isCompleted ? <span className="okBadge">Yes</span> : <span className="warningBadge">No</span>}</td>
                  <td>{r.exploration_split_t_s != null ? <span className="okBadge">{r.exploration_split_t_s.toFixed(1)} s</span> : <span className="warningBadge">missing</span>}</td>
                  <td>{r.learning_split_t_s != null ? <span className="okBadge">{r.learning_split_t_s.toFixed(1)} s</span> : <span className="warningBadge">missing</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </StatsCard>
  );

  const successCard = (
    <StatsCard
      key="success"
      title="Success by condition"
      tag={switchTag}
      info={(
        <>
          <h4>Success by condition — column definitions</h4>
          <p>For each of the 4 conditions (modality × delivery location):</p>
          <ul>
            <li><strong>Found all landmarks</strong> — valid trials where every placed landmark got at least one feedback event.</li>
            <li><strong>Landmarks collected</strong> — raw count of individual landmarks reached (a 2-of-3 trial contributes 2, not 0), out of every landmark placed under that condition <em>that was actually recorded and valid</em> (landmarks possible) — not out of the protocol ceiling.</li>
            <li><strong>Theoretical max</strong> — landmarks possible (same numerator as above) out of participants selected × 2 routes × 3 landmarks, i.e. what landmarks possible WOULD be if every participant had a valid trial on every route of that condition.</li>
            <li><strong>Valid trials</strong> — total trials run under that condition out of participants selected × 2 routes.</li>
            <li><strong>Participants</strong> — how many distinct participants contributed at least one of those trials.</li>
          </ul>
        </>
      )}
    >
      <p className="miniHint">{behavioralPatientCount} participants · {conditionBreakdown.reduce((a, c) => a + c.total, 0)} trials</p>
      <div className="copyPngRow">
        <CopyAsPngButton targetRef={conditionTableRef} label="Copy table" />
      </div>
      <div className="tableWrap" ref={conditionTableRef}>
        <table className="miniTable">
          <thead><tr><th>Condition</th><th>Found all landmarks</th><th>Landmarks collected</th><th>Theoretical max</th><th>Valid trials</th><th>Participants</th></tr></thead>
          <tbody>
            {conditionBreakdown.map((c) => (
              <tr key={c.condition}>
                <td>{shortConditionLabel(c.condition)}</td><td>{c.foundAll} / {c.total}</td><td>{c.targetsFound} / {c.targetsPossible}</td>
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
          <BarChart width={width} height={height} data={conditionChartData} margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" interval={0} tick={{ fontSize: 10 }} />
            <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 10 }} />
            <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => typeof v === 'number' ? `${v}%` : '—'} />
            <Bar dataKey="successRate" name="Found all landmarks" isAnimationActive={false} radius={[6, 6, 0, 0]}>
              {conditionChartData.map((d) => <Cell key={d.name} fill={CONDITION_COLORS[d.condition] ?? accent} />)}
            </Bar>
          </BarChart>
        )}</ChartFrame>
      </div>
    </StatsCard>
  );

  const qualityChart = QUALITY_CHARTS.find((q) => q.key === qualityChartKey) ?? QUALITY_CHARTS[0];
  const routeShapeCard = (
    <StatsCard
      key="routeShape"
      title="Route shape by condition"
      tag={switchTag}
      info={(
        <>
          <h4>Route shape by condition — column definitions</h4>
          <p>Mean of each valid trial's route-shape metrics (same figures as the Trial metrics mini-card's Shape overlap section), averaged per condition:</p>
          <ul>
            <li><strong>Shape dev (m)</strong> — mean pointwise distance between the learning and exploration routes (100-point arc-length resampled); lower is better.</li>
            <li><strong>Fréchet (m)</strong> — discrete Fréchet distance between the two routes; lower is better, dominated by the single worst-matching point rather than an average.</li>
            <li><strong>Overlap %</strong> — % of the exploration route within 0.5 m of some point on the learning route; higher is better.</li>
            <li><strong>n</strong> — valid trials averaged.</li>
          </ul>
          <Tex tex={String.raw`\text{Shape dev (m)} = \dfrac{1}{100}\sum_{k=1}^{100} d_k`} />
          <p>Average, over the 100 arc-length-resampled points on each route, of the distance between the exploration route's point k and the learning route's point k at the SAME relative position — order-sensitive.</p>
          <Tex tex={String.raw`\text{Overlap} \% = 100 \times \dfrac{\left|\{\,i : d_i \le 0.5\text{m}\,\}\right|}{N}`} />
          <p>% of the N raw exploration-route samples within 0.5 m of the NEAREST point anywhere on the learning route — order-independent, so it can score high even on a differently-shaped or backtracking route.</p>
        </>
      )}
    >
      <p className="miniHint">{behavioralPatientCount} participants · {sumBy(conditionQualityBreakdown, 'n')} trials</p>
      <div className="columnToggleRow">
        <span className="miniHintInline">Columns:</span>
        <label className="inlineCheck"><input type="checkbox" checked={qualityColumnsVisible.shapeDev} onChange={() => toggleQualityColumn('shapeDev')} />Shape dev (m)</label>
        <label className="inlineCheck"><input type="checkbox" checked={qualityColumnsVisible.frechet} onChange={() => toggleQualityColumn('frechet')} />Fréchet (m)</label>
        <label className="inlineCheck"><input type="checkbox" checked={qualityColumnsVisible.overlap} onChange={() => toggleQualityColumn('overlap')} />Overlap %</label>
        <label className="inlineCheck"><input type="checkbox" checked={qualityColumnsVisible.n} onChange={() => toggleQualityColumn('n')} />n</label>
      </div>
      <div className="copyPngRow">
        <CopyAsPngButton targetRef={qualityTableRef} label="Copy table" />
      </div>
      <div className="tableWrap" ref={qualityTableRef}>
        <table className="miniTable">
          <thead>
            <tr>
              <th>Condition</th>
              {qualityColumnsVisible.shapeDev ? <th>Shape dev (m)</th> : null}
              {qualityColumnsVisible.frechet ? <th>Fréchet (m)</th> : null}
              {qualityColumnsVisible.overlap ? <th>Overlap %</th> : null}
              {qualityColumnsVisible.n ? <th>n</th> : null}
            </tr>
          </thead>
          <tbody>
            {conditionQualityBreakdown.map((c) => (
              <tr key={c.condition}>
                <td>{shortConditionLabel(c.condition)}</td>
                {qualityColumnsVisible.shapeDev ? (
                  <td>
                    {fmtNum(c.shapeDeviationM, 2, ' m')}
                    {c.condition === qualityExtremes.shapeDeviationBest ? ' (lowest)' : ''}
                    {c.condition === qualityExtremes.shapeDeviationWorst ? ' (highest)' : ''}
                  </td>
                ) : null}
                {qualityColumnsVisible.frechet ? (
                  <td>{fmtNum(c.frechetDistanceM, 2, ' m')}{c.condition === qualityExtremes.frechetWorst ? ' (highest)' : ''}</td>
                ) : null}
                {qualityColumnsVisible.overlap ? (
                  <td>{fmtNum(c.overlapPct, 2, '%')}{c.condition === qualityExtremes.overlapWorst ? ' (lowest)' : ''}</td>
                ) : null}
                {qualityColumnsVisible.n ? <td>{c.n}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="copyPngRow chartPickerRow">
        <div className="chartPicker" role="radiogroup" aria-label="Measure in the chart">
          {QUALITY_CHARTS.map((q) => (
            <button key={q.key} type="button" role="radio" aria-checked={q.key === qualityChart.key} onClick={() => setQualityChartKey(q.key)}>{q.label}</button>
          ))}
        </div>
        <CopyAsPngButton targetRef={shapeDeviationChartRef} label="Copy chart" />
      </div>
      <div ref={shapeDeviationChartRef}>
        <ChartFrame height={220} minWidth={260}>{(width, height) => (
          <BarChart width={width} height={height} data={qualityChartData} margin={{ top: 12, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" interval={0} tick={{ fontSize: 10 }} />
            <YAxis unit={qualityChart.unit} domain={qualityChart.key === 'overlapPct' ? [0, 100] : undefined} tick={{ fontSize: 10 }} />
            <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => typeof v === 'number' ? `${v.toFixed(2)}${qualityChart.unit}` : '—'} />
            <Bar dataKey={qualityChart.key} name={qualityChart.label} isAnimationActive={false} radius={[6, 6, 0, 0]}>
              {qualityChartData.map((d) => <Cell key={d.name} fill={CONDITION_COLORS[d.condition] ?? accent} />)}
            </Bar>
          </BarChart>
        )}</ChartFrame>
      </div>
    </StatsCard>
  );

  const durationCard = (
    <StatsCard
      key="duration"
      title="Duration by condition"
      tag={switchTag}
      info={<p>Mean exploration duration per condition, over the same valid trials (one attempt per participant × condition × route) as the other cards. "Learning" is the same trials' own learning recordings, as a reference for how long the route took to teach.</p>}
    >
      <p className="miniHint">{behavioralPatientCount} participants · {sumBy(conditionCompletion, 'totalAttempts')} trials</p>
      <div className="copyPngRow">
        <CopyAsPngButton targetRef={durationTableRef} label="Copy table" />
      </div>
      <div className="tableWrap" ref={durationTableRef}>
        <table className="miniTable">
          <thead><tr><th>Condition</th><th>Mean duration (exploration)</th><th>Mean duration (learning)</th></tr></thead>
          <tbody>
            {conditionCompletion.map((c) => (
              <tr key={c.condition}>
                <td>{shortConditionLabel(c.condition)}</td>
                <td>
                  {fmtNum(c.meanDurationS, 0, ' s')}
                  {c.condition === durationExtremes.shortest ? ' (shortest)' : ''}
                  {c.condition === durationExtremes.longest && durationExtremes.shortestS
                    ? ` (longest, +${Math.round(100 * (durationExtremes.longestS! / durationExtremes.shortestS - 1))}% vs shortest)`
                    : ''}
                </td>
                <td className="miniHintInline">{fmtNum(c.meanLearningDurationS, 0, ' s')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="copyPngRow">
        <CopyAsPngButton targetRef={durationChartRef} label="Copy chart" />
      </div>
      <div ref={durationChartRef}>
        <ChartFrame height={220} minWidth={260}>{(width, height) => (
          <BarChart width={width} height={height} data={durationChartData} margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" interval={0} tick={{ fontSize: 10 }} />
            <YAxis unit=" s" tick={{ fontSize: 10 }} />
            <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => typeof v === 'number' ? `${v.toFixed(0)} s` : '—'} />
            <Bar dataKey="meanDurationS" name="Mean duration" isAnimationActive={false} radius={[6, 6, 0, 0]}>
              {durationChartData.map((d) => <Cell key={d.name} fill={CONDITION_COLORS[d.condition] ?? accent} />)}
            </Bar>
          </BarChart>
        )}</ChartFrame>
      </div>
    </StatsCard>
  );

  const proximityCard = (
    <StatsCard key="proximity" title="Landmark proximity and contacts" tag={switchTag}>
      <p className="miniHint">{behavioralPatientCount} participants · {filteredValidTrialRows.length} trials</p>
      <h4 className="cardSubhead">Closest feedback zone reached</h4>
      <p className="miniHint">Trials, by landmark and condition, in which that landmark reached the closest feedback zone observed (bucket {proximityBreakdown.closestZone ?? '—'}).</p>
      <div className="tableWrap">
        <table className="miniTable">
          <thead>
            <tr>
              <th>Landmark</th>
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
      <h4 className="cardSubhead">Contacts with the landmark objects</h4>
      <p className="miniHint">Contact events, not trials: one trial can register more than one.</p>
      <div className="tableWrap">
        <table className="miniTable">
          <thead><tr><th>Landmark</th><th>Contacts</th></tr></thead>
          <tbody>
            {['O1', 'O2', 'O3'].map((tid) => (
              <tr key={tid}><td>{tid}</td><td>{impactBreakdown.perTarget[tid] ?? 0}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </StatsCard>
  );

  const summaryInfo = <p>p value of each effect of the 2×2 repeated-measures ANOVA; bold = p &lt; 0.05. Border crossings also show the rank-transformed test. Click a measure to open its card.</p>;
  const summaryCards = anovaResults ? [
    <StatsCard key="summary1" title="First task and landmarks: p values" tag={anovaTag(completeCount)} info={summaryInfo}>
      <AnovaSummaryTable results={anovaResults} groups={['task1', 'whole']} onPick={pickDv} />
    </StatsCard>,
    <StatsCard key="summary2" title="Second task: p values" tag={anovaTag(completeCount)} info={summaryInfo}>
      <AnovaSummaryTable results={anovaResults} groups={['task2']} onPick={pickDv} />
    </StatsCard>,
  ] : [];

  const howAnovaCard = (
    <StatsCard key="how" className="wide" title="How the ANOVA works" tag={anovaTag(completeCount)}>
      <div className="cardProse columns">
        <div>
          <h4>Design</h4>
          <p>Feedback <strong>modality</strong> (auditory, haptic) × <strong>location</strong> (external, on person): a 2×2 design repeated on every participant, so each participant is compared with themselves across the four conditions.</p>
        </div>
        <div>
          <h4>Held constant</h4>
          <p><strong>Route</strong>: each condition has its own pair of routes, averaged into one value per participant and condition. <strong>Phase</strong>: every measure comes from the exploration recording; some are also compared with the learning recording of the same trial.</p>
        </div>
        <div>
          <h4>Who is included</h4>
          <p>Only participants with a valid value in all four conditions ({completeCount}).{excludedList ? ` Left out for data quality, still shown in the other sections: ${excludedList}.` : ''}</p>
        </div>
        <div>
          <h4>Reading the box plots</h4>
          <p>{BOX_PLOT_READING}</p>
        </div>
        <div>
          <h4>Not tested</h4>
          <p>Contacts and the raw number of landmarks found are low counts and fit the ANOVA poorly. Border crossings are tested, with a rank-transformed ANOVA as a check.</p>
        </div>
      </div>
    </StatsCard>
  );

  const approachCards = (dv: AnovaDvResult): ReactNode[] => {
    const cards: ReactNode[] = [renderDvCard(dv, 'main'), renderDvCard(dv, 'box')];
    if (dv.approach_groups) {
      cards.push(
        <StatsCard key="depthGroups" title="Participants by how far into the feedback they went" tag={anovaTag(dv.n_patients)}>
          <ParticipantGroupsChart
            title="First task · Participants by how far into the feedback they went"
            groups={APPROACH_GROUPS}
            conditions={dv.conditions}
            counts={dv.approach_groups}
            total={dv.n_patients}
            note="Only landmarks that gave feedback before point E count."
          />
        </StatsCard>,
      );
    }
    if (dv.reach_groups) {
      cards.push(
        <StatsCard key="reachGroups" title="Participants by how many landmarks they found" tag={anovaTag(dv.n_patients)}>
          <ParticipantGroupsChart
            title="First task · Participants by how many landmarks they found"
            groups={REACH_GROUPS}
            conditions={dv.conditions}
            counts={dv.reach_groups}
            total={dv.n_patients}
            note="Counted over the routes of the condition together (3 landmarks each), same “landmarks reached” as in the Landmarks section."
          />
        </StatsCard>,
      );
    }
    return cards;
  };

  const mixedIntroCard = (
    <StatsCard key="mixedIntro" title="What the mixed model is" tag={tagOf('mixed')}>
      <div className="cardProse">
        <p>The same question as the ANOVA (does the type of signal, or where it is placed, change the result?), answered with more data.</p>
        <ul>
          <li>The ANOVA drops a participant if even one of the 4 conditions is missing, and merges the two routes of a condition into one average.</li>
          <li>The mixed model keeps every valid trial. A participant with 5 trials out of 8 still counts, with those 5.</li>
          <li>It also knows that trials are not independent: a skilled participant does well everywhere, and a hard route is hard for everyone. It sets these two things aside and looks at what is left, the effect of the signal.</li>
        </ul>
        <h4>How to read a row</h4>
        <p>Example: "Haptic − auditory, +0.34 m, +0.06 to +0.62".</p>
        <ul>
          <li><strong>Difference:</strong> haptic minus auditory. Positive means the value was higher with the haptic signal, here by 0.34 m on average.</li>
          <li><strong>95% range:</strong> the real difference is not known exactly. 0.34 m is the best guess, but it could be anywhere between 0.06 and 0.62 m.</li>
          <li><strong>Look for 0 in the range:</strong> if the range does not contain 0, the difference is real enough to report (bold). If it contains 0, nothing can be concluded.</li>
          <li><strong>Better:</strong> for all three measures a lower value is better, so this column names the side with the lower value. "Not clear" means that side did better in this sample, but it could be by chance.</li>
        </ul>
      </div>
    </StatsCard>
  );

  const mixedCards = (anovaResults?.mixed_models ?? []).map((model) => {
    const unit = model.label.match(/\(([^)]+)\)/)?.[1] ?? '';
    const name = model.label.replace(/\s*\([^)]*\)/, '');
    const taskTitle = DV_GROUPS.find((g) => g.key === model.group)?.title ?? '';
    const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
    return (
      <StatsCard key={model.dv} title={`${taskTitle} · ${name}`} tag={{ tone: 'mixed', label: `${model.n_patients} participants · ${model.n_trials} trials`, fixed: true }}>
        {model.insufficient_data || !model.effects ? (
          <p className="miniHint">Not enough data to estimate the model{model.error ? ` (${model.error})` : ''}.</p>
        ) : (
          <>
            <div className="tableWrap">
              <table className="miniTable">
                <thead>
                  <tr><th>Comparison</th><th>Better</th><th>Difference ({unit})</th><th>95% range</th><th>p</th></tr>
                </thead>
                <tbody>
                  {MIXED_MODEL_ROWS.map((row) => {
                    const effect = model.effects![row.key];
                    const clear = effect.p < 0.05;
                    // Lower is better for all three measures: a positive
                    // difference means the second level did better.
                    const better = row.levels ? row.levels[effect.estimate > 0 ? 1 : 0] : null;
                    return (
                      <tr key={row.key} title={row.hint}>
                        <td>{row.label}</td>
                        <td>
                          {better == null ? '—' : clear
                            ? <span className="anovaSignificant">{better}</span>
                            : <>{better} <span className="miniHintInline">(not clear)</span></>}
                        </td>
                        <td className={clear ? 'anovaSignificant' : undefined}>{signed(effect.estimate)}</td>
                        <td>{signed(effect.ci_low)} to {signed(effect.ci_high)}</td>
                        <td className={clear ? 'anovaSignificant' : undefined}>{effect.p < 0.001 ? '< 0.001' : effect.p.toFixed(3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="miniHint">
              Average across conditions: {model.intercept?.toFixed(2)} {unit}. Similarity accounted for: {model.random_effects}.
              {model.converged === false ? ' The estimation did not fully settle: treat these numbers with caution.' : ''}
            </p>
          </>
        )}
      </StatsCard>
    );
  });

  // Second line of a section in the panel: what is in it and, for the tests,
  // how many measures reach p < 0.05.
  const significantDvs = (dvs: AnovaDvResult[]) => dvs.filter((dv) => dv.effects && Object.values(dv.effects).some((e) => e && e.p < 0.05)).length;
  const testedMeta = (dvs: AnovaDvResult[]) => {
    if (!anovaResults) return <>loading…</>;
    const n = significantDvs(dvs);
    return <>{dvs.length} measure{dvs.length === 1 ? '' : 's'} · <span className={n ? 'sigText' : undefined}>{n} with p &lt; 0.05</span></>;
  };
  const categoryMeta = (key: CategoryKey): ReactNode => {
    switch (key) {
      case 'overview': return 'Sessions, trials, who is in';
      case 'conditions': return 'Landmarks, route, duration, contacts';
      case 'anova': return testedMeta(anovaResults?.dvs ?? []);
      case 'task1': case 'task2': return testedMeta(dvsOf(key));
      case 'approach': return testedMeta((anovaResults?.dvs ?? []).filter((dv) => dv.dv === APPROACH_DV));
      case 'landmarks': return testedMeta(dvsOf('whole'));
      case 'flow': return 'Landmarks → end point → return';
      case 'mixed': {
        const models = (anovaResults?.mixed_models ?? []).filter((m) => !m.insufficient_data && m.effects);
        if (!anovaResults) return <>loading…</>;
        const n = models.filter((m) => Object.values(m.effects!).some((e) => e.p < 0.05)).length;
        return <>{models.length} measures · <span className={n ? 'sigText' : undefined}>{n} with a clear difference</span></>;
      }
      case 'notes': return 'Your observations';
      default: return null;
    }
  };

  const cardsFor = (key: CategoryKey): ReactNode[] => {
    switch (key) {
      case 'overview': return [sessionsCard, trialsCard, participantsCard, outcomesCard];
      case 'conditions': return [successCard, routeShapeCard, durationCard, proximityCard];
      case 'anova': return summaryCards.length ? [howAnovaCard, ...summaryCards] : [anovaPending('ANOVA')];
      case 'task1':
      case 'task2': {
        const dvs = dvsOf(key);
        if (!dvs.length) return [anovaPending('No measure')];
        return [glanceCard(key === 'task1' ? 'First task' : 'Second task', dvs), ...dvs.map((dv) => renderDvCard(dv))];
      }
      case 'approach': {
        const dv = anovaResults?.dvs.find((d) => d.dv === APPROACH_DV);
        return dv ? approachCards(dv) : [anovaPending('No approach depth')];
      }
      case 'landmarks': {
        const dvs = dvsOf('whole');
        return dvs.length ? dvs.map((dv) => renderDvCard(dv)) : [anovaPending('No measure')];
      }
      case 'flow':
        return [
          <TrialFlowCards
            key="flow"
            rows={filteredValidTrialRows}
            completed={completed}
            thresholdM={returnThreshold}
            sampleLabel={completeCasesOnly ? 'participants with all four conditions' : 'participants shown'}
            tag={switchTag}
          />,
        ];
      case 'mixed': return mixedCards.length ? [mixedIntroCard, ...mixedCards] : [anovaPending('No mixed model')];
      case 'notes':
        return [
          <StatsCard key="notes" title="Observations" tag={null} info={<p>Your notes about these results, saved on the server when you click outside the box.</p>}>
            <ObservationsBox sectionKey="anova" />
          </StatsCard>,
        ];
      default: return [];
    }
  };

  const openKeys = CATEGORIES.filter((c) => openCats.has(c.key)).map((c) => c.key);

  return (
    <div className="statsLayout">
      <aside className="statsSidebar" aria-label="Participants and sections">
        <div className="sidebarBlock">
          <span className="controlLabel">Participants</span>
          <div className="sampleOptions" role="radiogroup" aria-label="Participants counted by the sections that follow the switch">
            <button type="button" role="radio" aria-checked={completeCasesOnly} className="sampleOption tone-ten" onClick={() => setCompleteCasesOnly(true)}>
              <strong>{countsReady ? completeCount : '…'}</strong><span>with all 4 conditions</span>
            </button>
            <button type="button" role="radio" aria-checked={!completeCasesOnly} className="sampleOption tone-all" onClick={() => setCompleteCasesOnly(false)}>
              <strong>{countsReady ? includedPatients.length : '…'}</strong><span>all shown</span>
            </button>
          </div>
          <p className="sampleNote">
            {!countsReady
              ? <>Loading the trials of every participant…</>
              : completeCasesOnly
                ? <>Every section counts the same {completeCount} participants, except the mixed model{mixedN != null ? ` (${mixedN})` : ''}, which also keeps participants with a condition missing.</>
                : <>Describe the data and Trial flow count all {includedPatients.length} participants (pink). The tests keep the {completeCount} <Lock size={11} className="inlineIcon" />.</>}
          </p>
        </div>

        <nav className="sidebarBlock" aria-label="Sections of General statistics">
          <div className="controlHead">
            <span className="controlLabel">Sections</span>
            <button type="button" className="catAll" onClick={() => setOpenCats(allOpen ? new Set() : new Set(CATEGORIES.map((c) => c.key)))}>
              {allOpen ? 'Close all' : 'Open all'}
            </button>
          </div>
          <p className="sidebarHint">Tick a section to show it, click its name to go there. Read from 1 to 3.</p>
          {CATEGORY_GROUPS.map((group, gi) => (
            <div className="navGroup" key={group.key}>
              <div className="navGroupHead">
                <span className="navStep">{gi + 1}</span>
                <div>
                  <strong>{group.title}</strong>
                  <small>{group.hint}</small>
                </div>
              </div>
              <ul>
                {group.items.map((key) => {
                  const c = CATEGORY_BY_KEY[key];
                  const Icon = c.icon;
                  const tag = tagOf(c.sample);
                  const open = openCats.has(key);
                  return (
                    <li
                      key={key}
                      className={`navItem tone-${tag?.tone ?? 'none'}${SUB_CATEGORIES.has(key) ? ' sub' : ''}${open ? ' open' : ''}${activeCat === key ? ' active' : ''}`}
                      aria-current={activeCat === key ? 'location' : undefined}
                    >
                      <input type="checkbox" checked={open} onChange={(e) => setSectionOpen(key, e.target.checked)} aria-label={`Show ${c.title}`} title={open ? 'Hide this section' : 'Show this section'} />
                      <button type="button" className="navLink" onClick={() => openSection(key)} title={`${c.hint}${tag ? ` · ${tag.label}${tag.fixed ? ' (fixed)' : ''}` : ''}`}>
                        <span className="navTitle">
                          <Icon size={14} />
                          {c.title}
                          {tag?.fixed ? <Lock size={10} className="navLock" /> : null}
                        </span>
                        <span className="navMeta">{categoryMeta(key)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="statsMain">
        <section className="card statsIntro">
          <div className="cardHeader">
            <div>
              <h2>General statistics</h2>
              <p>
                Choose the participants and the sections in the panel on the left. The colour of a card says who it counts:
                {' '}<span className="toneWord tone-ten">teal</span> = the {countsReady ? completeCount : '…'} participants with all four conditions (the ANOVA sample),
                {' '}<span className="toneWord tone-all">pink</span> = all {countsReady ? includedPatients.length : '…'} participants shown,
                {' '}<span className="toneWord tone-mixed">grey</span> = the mixed model{mixedN != null ? ` (${mixedN} participants)` : ''}.
                {' '}<Lock size={12} className="inlineIcon" /> = the card keeps its own participants, whatever the switch.
              </p>
            </div>
            {dataLoading ? <RefreshCw size={16} className="spin" /> : null}
          </div>
        </section>

        {openKeys.length === 0 ? <p className="statsEmpty">Tick a section in the panel on the left.</p> : null}

        {openKeys.map((key, i) => {
          const c = CATEGORY_BY_KEY[key];
          const Icon = c.icon;
          const tag = tagOf(c.sample);
          const cards = cardsFor(key);
          const aligned = key === 'task1' || key === 'task2' || key === 'landmarks';
          // Next section in reading order, open or not.
          const next = CATEGORIES[CATEGORIES.findIndex((x) => x.key === key) + 1];
          const nextTag = next ? tagOf(next.sample) : null;
          return (
            <section key={key} id={`cat-${key}`} className={`statsCategory tone-${tag?.tone ?? 'none'}`}>
              <header className="statsCategoryHeader">
                <Icon size={18} />
                <h2>{c.title}</h2>
                <span className="catHint">{c.hint}</span>
                {tag ? <SampleChip tag={tag} /> : null}
                <button type="button" className="closeCat" aria-label={`Close ${c.title}`} title="Close this section" onClick={() => setSectionOpen(key, false)}>
                  <X size={16} />
                </button>
              </header>
              <div className={`statsGrid${aligned ? ' aligned' : ''}${cards.length === 1 && key !== 'flow' ? ' single' : ''}`}>{cards}</div>
              {next ? (
                <footer className="statsCategoryFooter">
                  <button type="button" className={`nextSection tone-${nextTag?.tone ?? 'none'}`} onClick={() => openSection(next.key)}>
                    {openKeys[i + 1] === next.key ? 'Next' : 'Open next'}: {next.title}
                    <ArrowRight size={14} />
                  </button>
                </footer>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** One cell of a section's grid: title, the participants it counts, content. */
function StatsCard({ title, tag, info, extra, id, className, children }: {
  title: ReactNode;
  tag: SampleTag | null;
  info?: ReactNode;
  extra?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article className={`behavioralSubcard statsCard tone-${tag?.tone ?? 'none'}${className ? ` ${className}` : ''}`} id={id}>
      <header className="statsCardHeader">
        <h3>{title}{info ? <InfoPopover>{info}</InfoPopover> : null}{extra}</h3>
        {tag ? <SampleChip tag={tag} /> : null}
      </header>
      {children}
    </article>
  );
}

/** Coloured pill naming the participants a card or section counts; a lock
 * when they stay fixed whatever the Participants switch says. */
function SampleChip({ tag }: { tag: SampleTag }) {
  return (
    <span className={`sampleChip tone-${tag.tone}`} title={tag.fixed ? 'Fixed: does not follow the Participants switch' : 'Follows the Participants switch'}>
      {tag.fixed ? <Lock size={11} /> : <span className="sampleDot" />}
      {tag.label}
    </span>
  );
}

const EFFECT_NAMES = { modality: 'Modality', location: 'Location', interaction: 'Modality × location' } as const;

/** Means of every measure of a section, conditions side by side, with the
 * effects that reach p < 0.05. A measure name opens its card. */
function GlanceTable({ dvs, onPick }: { dvs: AnovaDvResult[]; onPick: (dv: AnovaDvResult) => void }) {
  const conditions = dvs.find((dv) => dv.conditions.length)?.conditions ?? [];
  const effectKeys = Object.keys(EFFECT_NAMES) as Array<keyof typeof EFFECT_NAMES>;
  return (
    <div className="tableWrap">
      <table className="miniTable glanceTable">
        <thead>
          <tr>
            <th>Measure</th>
            {conditions.map((c) => <th key={c}><span className="pathDot" style={{ background: CONDITION_COLORS[c] ?? '#888' }} />{shortConditionLabel(c)}</th>)}
            <th>p &lt; 0.05</th>
          </tr>
        </thead>
        <tbody>
          {dvs.map((dv) => {
            const significant = effectKeys.filter((k) => (dv.effects?.[k]?.p ?? 1) < 0.05);
            return (
              <tr key={dv.dv}>
                <td><button type="button" className="linkButton" onClick={() => onPick(dv)}>{dv.label}</button></td>
                {conditions.map((c) => <td key={c}>{fmtNum(dv.cell_means?.[c]?.mean, 2)}</td>)}
                <td className={significant.length ? 'anovaSignificant' : undefined}>{significant.length ? significant.map((k) => EFFECT_NAMES[k]).join(', ') : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Stacked bars, one per condition: how many participants fall in each
 * group, with a worked example of how to read the first bar underneath. */
function ParticipantGroupsChart({ title, groups, conditions, counts, total, note }: {
  title: string;
  groups: ParticipantGroup[];
  conditions: string[];
  counts: Record<string, Record<string, number>>;
  total: number;
  note: string;
}) {
  const example = conditions[0];
  return (
    <div className="participantGroups">
      <CopyableChart title={title}>
        <ChartFrame height={260} minWidth={220}>{(width, height) => (
          <BarChart
            width={width}
            height={height}
            data={conditions.map((c) => ({ label: shortConditionLabel(c), ...counts[c] }))}
            margin={{ top: 12, right: 12, bottom: 8, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} domain={[0, total]} ticks={[0, Math.round(total / 2), total]} label={{ value: 'participants', angle: -90, position: 'insideLeft', fontSize: 10, dx: 14 }} />
            <Tooltip animationDuration={0} isAnimationActive={false} formatter={(v: unknown) => `${v} of ${total} participants`} />
            <Legend layout="vertical" align="center" wrapperStyle={{ fontSize: 11 }} itemSorter={(item) => groups.findIndex((g) => g.label === item.value)} formatter={(value: string) => <span style={{ color: 'var(--text)' }}>{value}</span>} />
            {groups.map((g) => (
              <Bar key={g.key} dataKey={g.key} name={g.label} stackId="groups" fill={g.color} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
                <LabelList dataKey={g.key} position="center" style={{ fill: g.labelColor, fontSize: 12, fontWeight: 600 }} formatter={(v: unknown) => (v ? (width >= 520 ? `${v} participant${v === 1 ? '' : 's'}` : `${v} pp`) : '')} />
              </Bar>
            ))}
          </BarChart>
        )}</ChartFrame>
      </CopyableChart>
      <p className="miniHint">
        <strong>How to read it.</strong> Each bar is the {total} participants. The numbers inside the bars count participants, never landmarks.
        {example ? ` Example, ${shortConditionLabel(example)}: ${groups.map((g) => `${counts[example]?.[g.key] ?? 0} ${g.reading}`).join(', ')}.` : ''}
        {' '}{note}
      </p>
    </div>
  );
}

// Columns of the trial-flow diagram after the condition column. Each trial
// sits in exactly one node per column.
const FLOW_COLUMNS: Array<{ title: string; nodes: string[] }> = [
  { title: 'Landmarks found', nodes: ['3 landmarks', '2 landmarks', '1 landmark', 'No landmark'] },
  { title: 'End point', nodes: ['Reached', 'Missed'] },
  { title: 'Return to start', nodes: ['Back at start', 'Not back'] },
];

/** Where trials go along the route: participant -> condition -> landmarks
 * found -> end point reached or not -> back at the start or not. One ribbon
 * per condition and pair of nodes; its thickness is the number of trials.
 * The participants are the ones selected for the whole tab (`rows`); only
 * trials with point E marked on both recordings (the end point cannot be
 * judged without). */
function TrialFlowCards({ rows, completed, thresholdM, sampleLabel, tag }: {
  rows: TrialRow[];
  completed: (r: TrialRow) => boolean;
  thresholdM: number;
  sampleLabel: string;
  tag: SampleTag;
}) {
  const trials = useMemo(() => rows
    .filter((r) => r.target_discovery && r.stop_position_distance_m != null && r.exploration_split_t_s != null)
    .map((r) => ({
      patient: r.patient,
      condition: r.condition,
      path: [
        3 - Math.min(3, r.target_discovery!.found_count),
        (r.stop_position_distance_m as number) <= thresholdM ? 0 : 1,
        completed(r) ? 0 : 1,
      ],
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, thresholdM]);
  const conditions = useMemo(() => uniq(trials.map((t) => t.condition)), [trials]);
  const patients = useMemo(() => uniq(trials.map((t) => t.patient)), [trials]);
  if (!trials.length) {
    return (
      <StatsCard title="Trial flow" tag={tag}>
        <p className="miniHint">No trial with point E marked on both recordings.</p>
      </StatsCard>
    );
  }

  const total = trials.length;
  type FlowTrial = (typeof trials)[number];
  const count = (pred: (t: FlowTrial) => boolean) => trials.filter(pred).length;
  // Node index of a trial in each column: participant, condition, then FLOW_COLUMNS.
  const nodeOf = (t: FlowTrial, k: number) => (k === 0 ? patients.indexOf(t.patient) : k === 1 ? conditions.indexOf(t.condition) : t.path[k - 2]);
  // Two lines each, so they fit narrow cards; the distance columns give their threshold.
  const columnTitles = [['Participant'], ['Condition'], ...FLOW_COLUMNS.map((c, k) => (k === 0 ? c.title.split(' ') : [c.title, `within ${thresholdM} m`]))];
  const lastColumn = columnTitles.length - 1;

  return (
    <>
      <StatsCard title="Trial flow" tag={tag}>
        <CopyableChart title="Trial flow · participant → condition → landmarks found → end point → return to start">
          <ChartFrame height={520} minWidth={480}>{(width, height) => {
            const nodeW = 12;
            const top = 40;
            const labelPad = 100;
            const columnNodes: Array<Array<{ label: string; n: number; y: number; color: string }>> = [
              patients.map((p) => ({ label: participantLabel(p), n: count((t) => t.patient === p), y: 0, color: 'var(--ink)' })),
              conditions.map((c) => ({ label: shortConditionLabel(c), n: count((t) => t.condition === c), y: 0, color: CONDITION_COLORS[c] ?? '#888' })),
              ...FLOW_COLUMNS.map((col, k) => col.nodes.map((label, i) => ({ label, n: count((t) => t.path[k] === i), y: 0, color: 'var(--ink)' }))),
            ];
            // Tighter gaps in the participant column, which has the most nodes.
            const gapOf = (k: number) => (k === 0 ? 6 : 16);
            const visibleCount = (k: number) => columnNodes[k].filter((n) => n.n > 0).length;
            const unit = Math.min(...columnNodes.map((_, k) => (height - top - 8 - gapOf(k) * (visibleCount(k) - 1)) / total));
            const colX = (k: number) => 8 + (k * (width - 16 - nodeW - labelPad)) / lastColumn;
            columnNodes.forEach((nodes, k) => {
              let y = top + (height - top - 8 - (total * unit + gapOf(k) * (visibleCount(k) - 1))) / 2;
              for (const n of nodes) {
                n.y = y;
                if (n.n > 0) y += n.n * unit + gapOf(k);
              }
            });
            // Ribbons: stacked inside the source node by target then condition,
            // and inside the target node by source then condition.
            const ribbons: Array<{ key: string; d: string; color: string; title: string }> = [];
            for (let k = 0; k < lastColumn; k += 1) {
              const sources = columnNodes[k];
              const targets = columnNodes[k + 1];
              const outY = sources.map((n) => n.y);
              const inY = targets.map((n) => n.y);
              const flows: Array<{ a: number; b: number; c: string; n: number; y0: number; y1: number }> = [];
              sources.forEach((_, a) => targets.forEach((__, b) => conditions.forEach((c) => {
                const n = count((t) => t.condition === c && nodeOf(t, k) === a && nodeOf(t, k + 1) === b);
                if (n > 0) flows.push({ a, b, c, n, y0: 0, y1: 0 });
              })));
              for (const f of flows) { f.y0 = outY[f.a]; outY[f.a] += f.n * unit; }
              for (const f of [...flows].sort((p, q) => p.b - q.b || p.a - q.a || conditions.indexOf(p.c) - conditions.indexOf(q.c))) { f.y1 = inY[f.b]; inY[f.b] += f.n * unit; }
              const x0 = colX(k) + nodeW;
              const x1 = colX(k + 1);
              const mid = (x0 + x1) / 2;
              for (const f of flows) {
                const h = f.n * unit;
                ribbons.push({
                  key: `${k}|${f.a}|${f.b}|${f.c}`,
                  color: CONDITION_COLORS[f.c] ?? '#888',
                  d: `M${x0},${f.y0} C${mid},${f.y0} ${mid},${f.y1} ${x1},${f.y1} L${x1},${f.y1 + h} C${mid},${f.y1 + h} ${mid},${f.y0 + h} ${x0},${f.y0 + h} Z`,
                  title: `${k === 0 ? '' : `${shortConditionLabel(f.c)}: `}${f.n} trial${f.n === 1 ? '' : 's'} — ${sources[f.a].label} → ${targets[f.b].label}`,
                });
              }
            }
            return (
              <svg width={width} height={height} role="img" aria-label="Trial flow by condition">
                {columnTitles.map((lines, k) => (
                  <text key={lines[0]} x={colX(k)} y={13} fontSize={11} fontWeight={600} fill="var(--muted)">
                    {lines.map((line, i) => <tspan key={line} x={colX(k)} dy={i === 0 ? 0 : 13}>{line}</tspan>)}
                  </text>
                ))}
                {ribbons.map((r) => (
                  <path key={r.key} className="trialFlowRibbon" d={r.d} fill={r.color}><title>{r.title}</title></path>
                ))}
                {columnNodes.map((nodes, k) => nodes.filter((n) => n.n > 0).map((n) => (
                  <g key={`${k}|${n.label}`}>
                    <rect x={colX(k)} y={n.y} width={nodeW} height={Math.max(2, n.n * unit)} rx={3} fill={n.color} />
                    <text x={colX(k) + nodeW + 6} y={n.y + (n.n * unit) / 2 - 2} fontSize={12} fontWeight={600} fill="var(--ink)" className="trialFlowLabel">{n.label}</text>
                    <text x={colX(k) + nodeW + 6} y={n.y + (n.n * unit) / 2 + 12} fontSize={11} fill="var(--muted)" className="trialFlowLabel">{n.n} trial{n.n === 1 ? '' : 's'}</text>
                  </g>
                )))}
              </svg>
            );
          }}</ChartFrame>
        </CopyableChart>
        <p className="miniHint">
          <strong>How to read it.</strong> Read from left to right. Each ribbon is a group of trials of one condition (its colour); the thicker it is, the more trials. A trial starts at its participant, goes to its condition, then to the number of landmarks found, then to whether the end point was reached, then to whether the participant came back to the start. Hover a ribbon for its number. Every number in the diagram is a number of trials.
          {' '}<strong>End point reached</strong> = point E of the exploration is within {thresholdM} m of point E of the learning recording. <strong>Back at start</strong> = the last position of the exploration recording is within {thresholdM} m of its own first position, the point the participant actually started from in that trial (recordings flagged as too short never count). The {thresholdM} m is the same limit used for “Completed” in Trial outcomes by participant. {total} trials of the {patients.length} {sampleLabel}: one per participant, condition and route, with point E marked on both recordings.
        </p>
      </StatsCard>
      <StatsCard title="Trial flow in numbers" tag={tag}>
        <div className="tableWrap">
          <table className="miniTable">
            <thead><tr><th>The {patients.length} participants</th><th>In all their trials</th><th>In some trials</th><th>In no trial</th></tr></thead>
            <tbody>
              {[
                { label: 'Found all 3 landmarks', ok: (t: FlowTrial) => t.path[0] === 0 },
                { label: `Reached the end point (within ${thresholdM} m)`, ok: (t: FlowTrial) => t.path[1] === 0 },
                { label: `Came back to the start (within ${thresholdM} m)`, ok: (t: FlowTrial) => t.path[2] === 0 },
              ].map((row) => {
                const perPatient = patients.map((p) => {
                  const own = trials.filter((t) => t.patient === p);
                  const good = own.filter(row.ok).length;
                  return good === own.length ? 'all' : good > 0 ? 'some' : 'none';
                });
                return (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {(['all', 'some', 'none'] as const).map((g) => <td key={g}>{perPatient.filter((v) => v === g).length}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="miniHint">Participants: each person is counted once per row, so every row adds up to {patients.length}.</p>
        <div className="tableWrap">
          <table className="miniTable">
            <thead><tr><th>Condition</th><th>Trials</th><th>All 3 landmarks</th><th>End point reached</th><th>Back at start</th><th>All three</th></tr></thead>
            <tbody>
              {conditions.map((c) => {
                const n = count((t) => t.condition === c);
                const cell = (k: number) => `${k} (${Math.round((100 * k) / n)}%)`;
                return (
                  <tr key={c}>
                    <td><span className="pathDot" style={{ background: CONDITION_COLORS[c] ?? '#888' }} />{shortConditionLabel(c)}</td>
                    <td>{n}</td>
                    <td>{cell(count((t) => t.condition === c && t.path[0] === 0))}</td>
                    <td>{cell(count((t) => t.condition === c && t.path[1] === 0))}</td>
                    <td>{cell(count((t) => t.condition === c && t.path[2] === 0))}</td>
                    <td>{cell(count((t) => t.condition === c && t.path.every((v) => v === 0)))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </StatsCard>
    </>
  );
}

/** The ANOVAs of the given tasks: measure, participants and the p value of
 * each effect; p < 0.05 in bold. Border crossings also show the rank test. */
function AnovaSummaryTable({ results, groups, onPick }: { results: AnovaResults; groups: Array<'task1' | 'task2' | 'whole'>; onPick: (dv: AnovaDvResult) => void }) {
  const fmtP = (p: number | undefined) => (p == null ? '—' : p < 0.001 ? '< 0.001' : p.toFixed(3));
  const cell = (dv: AnovaDvResult, key: 'modality' | 'location' | 'interaction') => {
    const e = dv.effects?.[key];
    const r = dv.rank_effects?.[key];
    if (!e) return <td>—</td>;
    return (
      <td className={e.p < 0.05 ? 'anovaSignificant' : undefined}>
        {fmtP(e.p)}
        {r ? <span className="miniHintInline"> (ranks {fmtP(r.p)})</span> : null}
      </td>
    );
  };
  return (
      <div className="tableWrap">
        <table className="miniTable">
          <thead><tr><th>Measure</th><th>Participants</th><th>Modality</th><th>Location</th><th>Modality × location</th></tr></thead>
          <tbody>
            {DV_GROUPS.filter((g) => groups.includes(g.key)).map((g) => {
              const dvs = results.dvs.filter((dv) => (dv.group ?? 'whole') === g.key);
              if (!dvs.length) return null;
              return [
                <tr key={`h-${g.key}`} className="anovaSummaryGroup"><td colSpan={5}>{g.title}</td></tr>,
                ...dvs.map((dv) => (
                  <tr key={dv.dv}>
                    <td><button type="button" className="linkButton" onClick={() => onPick(dv)}>{dv.label}</button></td>
                    <td>{dv.insufficient_data ? `${dv.n_patients} (too few)` : dv.n_patients}</td>
                    {dv.insufficient_data ? <><td>—</td><td>—</td><td>—</td></> : <>{cell(dv, 'modality')}{cell(dv, 'location')}{cell(dv, 'interaction')}</>}
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
  );
}

/** A chart with a "Copy chart" button. The copied PNG includes the title,
 * so the image still says what it shows once pasted elsewhere. */
function CopyableChart({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="copyableChart">
      <div className="copyPngRow"><CopyAsPngButton targetRef={ref} label="Copy chart" /></div>
      <div ref={ref} className="copyableChartTarget">
        <div className="copyableChartTitle">{title}</div>
        {children}
      </div>
    </div>
  );
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Box plot per condition with one dot per participant. Whiskers reach the
 * furthest value within 1.5 × the box height (Tukey); dots beyond are outliers. */
function BoxPlot({ width, height, conditions, values }: {
  width: number;
  height: number;
  conditions: string[];
  values: Record<string, Array<{ patient: string; value: number }>>;
}) {
  const margin = { top: 10, right: 12, bottom: 28, left: 40 };
  const all = conditions.flatMap((c) => (values[c] ?? []).map((v) => v.value));
  if (!all.length) return null;
  const dataMax = Math.max(...all);
  if (!(dataMax > 0)) return null;
  const max = dataMax * 1.05;
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const y = (v: number) => margin.top + plotH * (1 - v / max);
  const band = plotW / conditions.length;
  const boxW = Math.min(46, band * 0.45);
  const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 4 ? 1 : 0.5);
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return (
    <svg width={width} height={height} role="img" aria-label="Box plot by condition">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={margin.left} x2={width - margin.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="3 3" />
          <text x={margin.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{Number(t.toFixed(2))}</text>
        </g>
      ))}
      {conditions.map((c, i) => {
        const points = values[c] ?? [];
        const sorted = points.map((v) => v.value).sort((a, b) => a - b);
        if (!sorted.length) return null;
        const q1 = quantile(sorted, 0.25);
        const median = quantile(sorted, 0.5);
        const q3 = quantile(sorted, 0.75);
        const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        const fence = 1.5 * (q3 - q1);
        const low = sorted.find((v) => v >= q1 - fence) ?? sorted[0];
        const high = [...sorted].reverse().find((v) => v <= q3 + fence) ?? sorted[sorted.length - 1];
        const cx = margin.left + band * (i + 0.5);
        const color = CONDITION_COLORS[c] ?? '#888';
        return (
          <g key={c}>
            <line x1={cx} x2={cx} y1={y(high)} y2={y(q3)} stroke={color} />
            <line x1={cx} x2={cx} y1={y(q1)} y2={y(low)} stroke={color} />
            <line x1={cx - boxW / 4} x2={cx + boxW / 4} y1={y(high)} y2={y(high)} stroke={color} />
            <line x1={cx - boxW / 4} x2={cx + boxW / 4} y1={y(low)} y2={y(low)} stroke={color} />
            <rect x={cx - boxW / 2} y={y(q3)} width={boxW} height={Math.max(1, y(q1) - y(q3))} fill={color} fillOpacity={0.18} stroke={color} rx={3}>
              <title>{`max ${sorted[sorted.length - 1].toFixed(2)} · Q3 ${q3.toFixed(2)} · median ${median.toFixed(2)} · mean ${mean.toFixed(2)} · Q1 ${q1.toFixed(2)} · min ${sorted[0].toFixed(2)}`}</title>
            </rect>
            <line x1={cx - boxW / 2 - 5} x2={cx + boxW / 2 + 5} y1={y(mean)} y2={y(mean)} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="4 3" />
            <line x1={cx - boxW / 2} x2={cx + boxW / 2} y1={y(median)} y2={y(median)} stroke={color} strokeWidth={2.5} />
            {points.map((pt, k) => {
              // Fixed horizontal spread so dots with similar values don't hide each other.
              const dx = ((k % 5) - 2) * (boxW / 7);
              const outlier = pt.value < q1 - fence || pt.value > q3 + fence;
              return (
                <circle key={pt.patient} cx={cx + dx} cy={y(pt.value)} r={3.2} fill={outlier ? 'var(--surface)' : color} stroke={color} strokeWidth={1.2}>
                  <title>{`${participantLabel(pt.patient)}: ${pt.value.toFixed(2)}${outlier ? ' (unusual)' : ''}`}</title>
                </circle>
              );
            })}
            <text x={cx} y={height - 8} textAnchor="middle" fontSize={band < 60 ? 9 : 11} fill="var(--muted)">{shortConditionLabel(c)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Free-text observations about a block of results, saved on the backend
 * (observations.json) when the box loses focus. */
function ObservationsBox({ sectionKey }: { sectionKey: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    fetchObservations()
      .then((all) => { if (!cancelled) { setSaved(all[sectionKey] ?? ''); setText(all[sectionKey] ?? ''); } })
      .catch(() => { if (!cancelled) setSaved(''); });
    return () => { cancelled = true; };
  }, [sectionKey]);

  const persist = () => {
    if (saved == null || text === saved) return;
    setStatus('saving');
    saveObservation(sectionKey, text)
      .then(() => { setSaved(text); setStatus('saved'); })
      .catch(() => setStatus('error'));
  };

  return (
    <div className="observationsBox">
      <textarea
        value={text}
        disabled={saved == null}
        placeholder="Write your observations here…"
        rows={Math.min(30, Math.max(6, text.split('\n').length + 2))}
        onChange={(e) => { setText(e.target.value); setStatus('idle'); }}
        onBlur={persist}
      />
      <span className="miniHintInline">
        {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Could not save' : text !== (saved ?? '') ? 'Not saved yet' : ''}
      </span>
    </div>
  );
}
