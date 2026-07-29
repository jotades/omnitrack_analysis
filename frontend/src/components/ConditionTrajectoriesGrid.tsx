import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { fetchSessionDetail, saveAnnotation } from '../api';
import type { MetricSummary, SessionPayload, SessionRow, TargetDiscovery, TrackingPoint, TrialRow } from '../types';

/**
 * Overview grid for one patient: one mini chart per condition × path (8 with
 * the standard protocol: 4 conditions × 2 paths), each overlaying the
 * learning and exploration seeker trajectories, plus the aggregated trial
 * metrics for the currently-selected exploration attempt.
 *
 * Every recorded session is selectable per phase (not just valid ones) via a
 * dropdown, since inspecting a disrupted/lost attempt is often the point.
 * Payloads are fetched lazily for whichever session is currently selected.
 */

const PHASES = ['learning', 'exploration'] as const;
type PhaseName = (typeof PHASES)[number];

const phaseColors: Record<PhaseName, string> = {
  learning: '#3b5bfd',
  exploration: '#f79009',
};

// Same default view as the main trajectory chart: 8×12 m room rotated 90°.
const ROOM_X = 8;
const ROOM_Y = 12;
const MINI_W = 300;
const MINI_H = 210;
const MARGIN = 10;
const BORDER_COLOR = '#f79009';
// Centered "safe" inner box, same margins as the backend's border_reached_count
// and the Single Session 2D room trajectory's "Border 8×6 m" flag.
const BORDER_MARGIN_LONG_M = 2.0;
const BORDER_MARGIN_SHORT_M = 1.0;

// 1×1 m reference grid, precomputed once: room-x integers (0..ROOM_X) become
// horizontal lines, room-y integers (0..ROOM_Y) become vertical lines (the
// mini view is rotated the same way as toSvg).
const MINI_GRID = (() => {
  const horizontals: number[] = [];
  for (let rx = 0; rx <= ROOM_X; rx++) {
    const py = (ROOM_X - rx) / ROOM_X;
    horizontals.push(MARGIN + (1 - py) * (MINI_H - 2 * MARGIN));
  }
  const verticals: number[] = [];
  for (let ry = 0; ry <= ROOM_Y; ry++) {
    const px = ry / ROOM_Y;
    verticals.push(MARGIN + px * (MINI_W - 2 * MARGIN));
  }
  return { horizontals, verticals };
})();

interface Props {
  sessions: SessionRow[];
  patient: string;
  trialRows: TrialRow[];
  /** Skip the outer card + header — for embedding inside a per-patient
   * collapsible section that already provides its own title. */
  bare?: boolean;
  /** Fired after any per-trial annotation save, so an ancestor holding its own
   * copies of trial data (the collapsed header's lost-count badge and
   * aggregate tiles, General statistics) knows what changed — this grid's own
   * `annotationOverrides` state only affects what's rendered inside itself. */
  onAnnotationSaved?: (info: { condition: string; pathId: string; explorationSessionId: number | null; excludedFromStats: boolean }) => void;
  // Toolbar settings are controlled by the parent (PatientTrialSection) so
  // they survive the dropdown closing — this grid only mounts while open,
  // so state kept here would reset to defaults every time it's reopened.
  showBorder: boolean;
  onShowBorder: (v: boolean) => void;
  showAnchors: boolean;
  onShowAnchors: (v: boolean) => void;
  showGrid: boolean;
  onShowGrid: (v: boolean) => void;
  alpha: number;
  onAlpha: (v: number) => void;
  smoothTrajectory: boolean;
  onSmoothTrajectory: (v: boolean) => void;
  smoothOnlySeeker: boolean;
  onSmoothOnlySeeker: (v: boolean) => void;
}

interface CellPhase {
  phase: PhaseName;
  all: SessionRow[];
}

interface Cell {
  condition: string;
  label: string;
  path: string;
  phases: CellPhase[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidSession(s: SessionRow) {
  return s.status === 'completed' && !s.is_interrupt && !s.is_suspicious_short;
}

function timeLabel(startTime: string | null) {
  if (!startTime) return '?';
  const m = startTime.match(/(\d{2}):(\d{2}):(\d{2})/) ?? startTime.match(/(\d{2})_(\d{2})_(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : startTime;
}

function fmt(value: number | null | undefined, digits = 1, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

/** Distance label plus the ideal (learning) point it's measured against, e.g. "1.23 m (ideal 2.1, 4.5)". */
function fmtDeltaWithIdeal(value: number | null | undefined, ideal: [number, number] | null | undefined) {
  const base = fmt(value, 2, ' m');
  if (base === '—' || !ideal) return base;
  return `${base} (ideal ${ideal[0].toFixed(1)}, ${ideal[1].toFixed(1)})`;
}

/** Room (rotated 90°) → mini SVG coordinates. */
function toSvg(x: number, y: number) {
  const px = y / ROOM_Y; // display X: original y, 0..12
  const py = (ROOM_X - x) / ROOM_X; // display Y: rotated x, 0..8
  return {
    x: MARGIN + px * (MINI_W - 2 * MARGIN),
    y: MARGIN + (1 - py) * (MINI_H - 2 * MARGIN),
  };
}

type MiniEndpoint = { x: number; y: number; rawX: number; rawY: number; t: number };

function seekerPolyline(payload: SessionPayload): { d: string; start?: MiniEndpoint; end?: MiniEndpoint } {
  const seeker = payload.config.seeker_id;
  const rawPts = payload.tracking
    .filter((p: TrackingPoint) => p.tag_id === seeker && isFiniteNumber(p.x_plot) && isFiniteNumber(p.y_plot) && isFiniteNumber(p.t_s))
    .sort((a, b) => a.t_s - b.t_s);
  if (!rawPts.length) return { d: '' };
  const pts = rawPts.map((p) => toSvg(p.x_plot as number, p.y_plot as number));
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
  const first = rawPts[0];
  const last = rawPts[rawPts.length - 1];
  return {
    d,
    start: { ...pts[0], rawX: first.x_plot as number, rawY: first.y_plot as number, t: first.t_s },
    end: { ...pts[pts.length - 1], rawX: last.x_plot as number, rawY: last.y_plot as number, t: last.t_s },
  };
}

function borderRectSvg(payload: SessionPayload | undefined): { x: number; y: number; width: number; height: number } | null {
  const anchors = payload?.config.anchors ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const a of anchors) {
    const coords = (a as { coords?: unknown[] })?.coords;
    if (Array.isArray(coords) && isFiniteNumber(coords[0]) && isFiniteNumber(coords[1])) {
      xs.push(coords[0] as number);
      ys.push(coords[1] as number);
    }
  }
  if (!xs.length || !ys.length) return null;
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const [marginX, marginY] = (xMax - xMin) > (yMax - yMin)
    ? [BORDER_MARGIN_LONG_M, BORDER_MARGIN_SHORT_M]
    : [BORDER_MARGIN_SHORT_M, BORDER_MARGIN_LONG_M];
  const corners = [
    [xMin + marginX, yMin + marginY],
    [xMax - marginX, yMin + marginY],
    [xMax - marginX, yMax - marginY],
    [xMin + marginX, yMax - marginY],
  ].map(([x, y]) => toSvg(x, y));
  const xsSvg = corners.map((c) => c.x);
  const ysSvg = corners.map((c) => c.y);
  const x = Math.min(...xsSvg), x2 = Math.max(...xsSvg);
  const y = Math.min(...ysSvg), y2 = Math.max(...ysSvg);
  return { x, y, width: x2 - x, height: y2 - y };
}

function anchorMarkers(payload: SessionPayload) {
  const anchors = payload.config.anchors ?? [];
  return anchors
    .map((a) => {
      const coords = (a as { coords?: unknown[] })?.coords;
      const id = (a as { id?: string })?.id;
      if (!Array.isArray(coords) || !isFiniteNumber(coords[0]) || !isFiniteNumber(coords[1])) return null;
      const rawX = coords[0] as number;
      const rawY = coords[1] as number;
      const pt = toSvg(rawX, rawY);
      return { id: id ?? 'anchor', rawX, rawY, ...pt };
    })
    .filter((m): m is { id: string; rawX: number; rawY: number; x: number; y: number } => m !== null);
}

function targetMarkers(payload: SessionPayload) {
  const targets = payload.config.target_ids ?? [];
  return targets.map((tid) => {
    const pts = payload.tracking.filter((p) => p.tag_id === tid && isFiniteNumber(p.x) && isFiniteNumber(p.y));
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x as number).sort((a, b) => a - b);
    const ys = pts.map((p) => p.y as number).sort((a, b) => a - b);
    const rawX = xs[xs.length >> 1];
    const rawY = ys[ys.length >> 1];
    return { id: tid, rawX, rawY, ...toSvg(rawX, rawY) };
  }).filter((m): m is { id: string; rawX: number; rawY: number; x: number; y: number } => m !== null);
}

function MiniTrajectory({ payloads, showBorder, showAnchors, showGrid }: { payloads: Array<{ phase: PhaseName; payload: SessionPayload }>; showBorder: boolean; showAnchors: boolean; showGrid: boolean }) {
  const targets = payloads.length ? targetMarkers(payloads[0].payload) : [];
  const anchors = showAnchors && payloads.length ? anchorMarkers(payloads[0].payload) : [];
  const borderRect = showBorder ? borderRectSvg(payloads[0]?.payload) : null;
  return (
    <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} className="miniTrajSvg">
      <rect x={MARGIN} y={MARGIN} width={MINI_W - 2 * MARGIN} height={MINI_H - 2 * MARGIN}
        fill="none" stroke="var(--border)" strokeWidth={1} rx={3} />
      {showGrid ? (
        <g className="miniGridLines">
          {MINI_GRID.horizontals.map((y, i) => (
            <line key={`h${i}`} x1={MARGIN} x2={MINI_W - MARGIN} y1={y} y2={y} stroke="var(--border)" strokeWidth={0.5} opacity={0.5} />
          ))}
          {MINI_GRID.verticals.map((x, i) => (
            <line key={`v${i}`} x1={x} x2={x} y1={MARGIN} y2={MINI_H - MARGIN} stroke="var(--border)" strokeWidth={0.5} opacity={0.5} />
          ))}
        </g>
      ) : null}
      {borderRect ? (
        <rect x={borderRect.x} y={borderRect.y} width={borderRect.width} height={borderRect.height}
          fill={BORDER_COLOR} fillOpacity={0.06} stroke={BORDER_COLOR} strokeDasharray="4 3" strokeWidth={1} />
      ) : null}
      {anchors.map((a) => (
        <g key={a.id} className="miniAnchorMarker">
          <title>{`${a.id}: x=${a.rawX.toFixed(2)} m, y=${a.rawY.toFixed(2)} m`}</title>
          <rect x={a.x - 3} y={a.y - 3} width={6} height={6} fill="#7a5af8" opacity={0.85} />
          <text x={a.x + 5} y={a.y + 3} fontSize={8} fill="#7a5af8" opacity={0.9}>{a.id}</text>
        </g>
      ))}
      {targets.map((t) => (
        <g key={t.id} className="miniAnchorMarker">
          <title>{`${t.id}: x=${t.rawX.toFixed(2)} m, y=${t.rawY.toFixed(2)} m`}</title>
          <path d={`M${t.x - 4},${t.y - 4}L${t.x + 4},${t.y + 4}M${t.x - 4},${t.y + 4}L${t.x + 4},${t.y - 4}`}
            stroke="currentColor" strokeWidth={1.4} opacity={0.55} />
          <text x={t.x + 6} y={t.y - 4} fontSize={9} fill="currentColor" opacity={0.6}>{t.id}</text>
        </g>
      ))}
      {payloads.map(({ phase, payload }) => {
        const { d, start, end } = seekerPolyline(payload);
        if (!d) return null;
        const color = phaseColors[phase];
        return (
          <g key={phase}>
            <path d={d} fill="none" stroke={color} strokeWidth={1.6} opacity={0.85} />
            {start ? (
              <circle cx={start.x} cy={start.y} r={3.4} fill="var(--surface)" stroke={color} strokeWidth={1.6} className="miniAnchorMarker">
                <title>{`${phase} start: t=${start.t.toFixed(1)}s, x=${start.rawX.toFixed(2)} m, y=${start.rawY.toFixed(2)} m`}</title>
              </circle>
            ) : null}
            {end ? (
              <circle cx={end.x} cy={end.y} r={3.4} fill={color} className="miniAnchorMarker">
                <title>{`${phase} end: t=${end.t.toFixed(1)}s, x=${end.rawX.toFixed(2)} m, y=${end.rawY.toFixed(2)} m`}</title>
              </circle>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// One-line explanation per stat, shown on hover via the small info icon next
// to each label — exact definitions from the backend (analysis.py / settings.py).
const STAT_INFO: Record<string, string> = {
  'Overlap': 'Share of exploration-path points that fall within 0.5 m of the learning route (nearest-neighbor distance to the learned trajectory).',
  'Turn dev': "Mean degrees the exploration's turn angle differs from the learning phase's angle, averaged over the turns (up to 3) auto-detected along the learned route. Turns are wherever the learning trajectory actually turned — not assumed to be 90°.",
  'Wrong turns': 'Of the auto-detected learned turns (up to 3), how many the exploration either missed entirely (never came within 1.5 m of that point) or took at an angle more than 45° off the learned turn.',
  'Stop Δ': 'Distance between the exploration’s last tracked position and the learning trajectory’s own end point — the "ideal" stop location, whose coordinates are shown in brackets.',
  'Start Δ': 'Distance between the exploration’s first tracked position and the learning trajectory’s own start point — the "ideal" start location, whose coordinates are shown in brackets.',
  'Stops': 'Number of times the participant paused (speed below 0.08 m/s for at least 1 s) during this exploration attempt.',
  'Border': 'Number of times the participant stepped outside the centered 8×6 m safety box during this exploration attempt.',
  'Duration': 'Length of this exploration attempt.',
  'Feedback': 'Number of feedback events (audio/haptic cues) delivered during this attempt.',
  'Mean intensity': 'Average intensity of the feedback delivered during this attempt.',
  'Mean speed': 'Average walking speed during this exploration attempt.',
  'Min closest': 'Closest distance reached to any target during this exploration attempt.',
  'Return Δ': 'Distance between the exploration’s LAST tracked position and the learning trajectory’s own start point — did they go out and come back? This is how "completed the path" is defined; coordinates of the ideal return point are shown in brackets.',
  'Found': 'How many of the trial’s targets (O1/O2/O3) triggered at least one feedback event during this exploration attempt, out of how many were placed on this path. "in order"/"out of order" compares the order they were first triggered against the path’s intended visit order (from the learning session).',
  'Impacts': 'Total probable physical hits on any target sensor during this exploration attempt (a target’s accelerometer spiking above its stationary baseline).',
};

function fmtFound(td: TargetDiscovery | null): string {
  if (!td) return '—';
  const total = td.targets.length;
  if (!total) return '—';
  const orderTag = td.found_count === 0 ? '' : td.in_order ? ' (in order)' : ' (out of order)';
  return `${td.found_count}/${total}${orderTag}`;
}

export function TrialMiniStats({ row, metrics }: { row: TrialRow | null; metrics?: MetricSummary | null }) {
  const stats: Array<[string, string]> = row ? [
    ['Overlap', fmt(row.overlap_pct, 0, '%')],
    ['Turn dev', fmt(row.mean_turn_deviation_deg, 0, '°')],
    ['Wrong turns', row.wrong_turns_count != null ? String(row.wrong_turns_count) : '—'],
    ['Stop Δ', fmtDeltaWithIdeal(row.stop_position_distance_m, row.ideal_stop_xy)],
    ['Start Δ', fmtDeltaWithIdeal(row.start_position_distance_m, row.ideal_start_xy)],
    ['Return Δ', fmtDeltaWithIdeal(row.return_to_start_distance_m, row.ideal_start_xy)],
    ['Found', fmtFound(row.target_discovery)],
    ['Impacts', String(Object.values(row.target_impacts ?? {}).reduce((a, b) => a + b, 0))],
    ['Stops', row.stop_count != null ? String(row.stop_count) : '—'],
    ['Border', row.border_reached_count != null ? String(row.border_reached_count) : '—'],
  ] : [];
  if (metrics) {
    stats.push(
      ['Duration', fmt(metrics.duration_s, 0, 's')],
      ['Feedback', metrics.feedback_events != null ? String(metrics.feedback_events) : '—'],
      ['Mean intensity', fmt(metrics.mean_intensity, 0)],
      ['Mean speed', fmt(metrics.mean_speed_m_s, 2, ' m/s')],
      ['Min closest', fmt(metrics.min_closest_distance, 2, ' m')],
    );
  }
  if (!stats.length) return <div className="miniTrialStats miniTrialEmpty">No data available.</div>;
  return (
    <div className="miniTrialStats">
      <div className="miniStatGrid">
        {stats.map(([label, value]) => (
          <div key={label}>
            <span>
              {label}
              {STAT_INFO[label] ? (
                <span className="miniStatInfo" title={STAT_INFO[label]}>
                  <Info size={10} />
                </span>
              ) : null}
            </span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {row?.got_lost ? (
        <span className="warningBadge miniLostBadge">
          lost / disrupted attempt{row.manual_lost !== null && row.manual_lost !== undefined ? ' (manual)' : ''}
        </span>
      ) : null}
      {row?.excluded_from_stats ? (
        <span className="warningBadge miniLostBadge" title="Flagged as a hardware error / bad trial — excluded from all General statistics totals">
          excluded from statistics
        </span>
      ) : null}
      {row?.note ? <div className="miniWarning">{row.note}</div> : null}
    </div>
  );
}

interface AnnotationEditorProps {
  patient: string;
  condition: string;
  pathId: string;
  explorationSessionId: number | null;
  manualLost: boolean | null;
  comment: string;
  excludedFromStats: boolean;
  onSaved: (next: { manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }) => void;
}

/** Per-trial researcher annotation: a manual lost/not-lost override (the
 * automatic heuristic is a best-effort guess, hard to get right for every
 * edge case), a hardware-error/exclude-from-stats flag, plus a free-text
 * note. Saved to the backend on change/blur. */
function TrialAnnotationEditor({ patient, condition, pathId, explorationSessionId, manualLost, comment, excludedFromStats, onSaved }: AnnotationEditorProps) {
  const [localComment, setLocalComment] = useState(comment);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { setLocalComment(comment); }, [comment, explorationSessionId]);

  async function persist(nextManualLost: boolean | null, nextComment: string, nextExcluded: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      await saveAnnotation({ patient, condition, pathId, explorationSessionId, manualLost: nextManualLost, comment: nextComment, excludedFromStats: nextExcluded });
      onSaved({ manual_lost: nextManualLost, comment: nextComment, excluded_from_stats: nextExcluded });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="miniAnnotation">
      <select
        value={manualLost === null ? 'auto' : manualLost ? 'lost' : 'ok'}
        title="Override the automatically-detected lost/disrupted flag"
        onChange={(e) => {
          const v = e.target.value;
          persist(v === 'auto' ? null : v === 'lost', localComment, excludedFromStats);
        }}
      >
        <option value="auto">Auto-detected</option>
        <option value="lost">Mark: lost</option>
        <option value="ok">Mark: not lost</option>
      </select>
      <label className="inlineCheck miniExcludeCheck" title="Hardware error or otherwise bad trial — leave it visible here but drop it from every General statistics total">
        <input
          type="checkbox"
          checked={excludedFromStats}
          onChange={(e) => persist(manualLost, localComment, e.target.checked)}
        />
        Exclude from statistics
      </label>
      <textarea
        className="miniCommentBox"
        placeholder="Notes about this session…"
        rows={2}
        value={localComment}
        onChange={(e) => setLocalComment(e.target.value)}
        onBlur={() => { if (localComment !== comment) persist(manualLost, localComment, excludedFromStats); }}
      />
      {saving ? <span className="miniSavingHint">Saving…</span> : null}
      {saveError ? <span className="miniSavingHint miniSavingError">{saveError}</span> : null}
    </div>
  );
}

export function ConditionTrajectoriesGrid({
  sessions, patient, trialRows, bare = false, onAnnotationSaved,
  showBorder, onShowBorder, showAnchors, onShowAnchors, showGrid, onShowGrid,
  alpha, onAlpha, smoothTrajectory, onSmoothTrajectory, smoothOnlySeeker, onSmoothOnlySeeker,
}: Props) {
  const [payloads, setPayloads] = useState<Map<number, SessionPayload>>(new Map());
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [annotationOverrides, setAnnotationOverrides] = useState<Record<string, { manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }>>({});

  // Smoothing settings (or patient) changing should drop the stale cache —
  // but every effect also fires once on mount, and setting a *new* empty
  // Map/object there (even though the state already starts empty) still
  // bumps `payloads`/`choices` by reference. Since neededIds depends on
  // `choices` and the fetch effect depends on `neededIds`/`payloads`, that
  // phantom mount-time reset was enough to abort and restart the entire
  // first fetch batch for no reason. Skip each effect's own first run.
  const payloadsMounted = useRef(false);
  useEffect(() => {
    if (!payloadsMounted.current) { payloadsMounted.current = true; return; }
    setPayloads(new Map());
  }, [alpha, smoothTrajectory, smoothOnlySeeker]);
  const choicesMounted = useRef(false);
  useEffect(() => {
    if (!choicesMounted.current) { choicesMounted.current = true; return; }
    setChoices({});
    setAnnotationOverrides({});
  }, [patient]);

  // condition → paths from the current patient's recordings (any status):
  // path assignment varies per patient, so the grid is 4 conditions × the
  // 2 paths this patient actually ran = 8 charts. A cell whose recordings
  // are all invalid still shows up, as an explicitly empty chart.
  const cells = useMemo<Cell[]>(() => {
    const conditionMap = new Map<string, { label: string; paths: Set<string> }>();
    for (const s of sessions) {
      if (s.patient !== patient || !s.condition || !s.path_id) continue;
      const entry = conditionMap.get(s.condition) ?? { label: s.condition_label || s.condition, paths: new Set<string>() };
      entry.paths.add(s.path_id);
      conditionMap.set(s.condition, entry);
    }
    const out: Cell[] = [];
    for (const [condition, entry] of [...conditionMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const path of [...entry.paths].sort()) {
        out.push({
          condition,
          label: entry.label,
          path,
          phases: PHASES.map((phase) => ({
            phase,
            all: sessions
              .filter((s) => s.patient === patient && s.condition === condition && s.path_id === path && s.phase === phase)
              .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))),
          })),
        });
      }
    }
    return out;
  }, [sessions, patient]);

  // Default to the most recent recording per phase (valid or not — inspecting
  // a disrupted attempt is often exactly the point in this tab).
  const chosenId = (cell: Cell, cp: CellPhase): number | null => {
    if (!cp.all.length) return null;
    const key = `${cell.condition}|${cell.path}|${cp.phase}`;
    const chosen = choices[key];
    if (chosen !== undefined && cp.all.some((s) => s.session_id === chosen)) return chosen;
    return cp.all[cp.all.length - 1].session_id;
  };

  const neededIds = useMemo(() => {
    const ids = new Set<number>();
    for (const cell of cells) {
      for (const cp of cell.phases) {
        const id = chosenId(cell, cp);
        if (id !== null) ids.add(id);
      }
    }
    return [...ids];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, choices]);

  useEffect(() => {
    const missing = neededIds.filter((id) => !payloads.has(id));
    if (!missing.length) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all(
      missing.map((id) => fetchSessionDetail(id, alpha, smoothTrajectory, smoothOnlySeeker, 400, controller.signal)
        .then((p) => [id, p] as const))
    )
      .then((entries) => setPayloads((prev) => new Map([...prev, ...entries])))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [neededIds, payloads, alpha, smoothTrajectory, smoothOnlySeeker]);

  if (!cells.length) return null;

  const gridBody = (
    <div className="conditionGridBody">
      {error ? <div className="errorBox">{error}</div> : null}
      <div className="miniGridToolbar">
        <label className="inlineCheck">
          <input type="checkbox" checked={showBorder} onChange={(e) => onShowBorder(e.target.checked)} />
          Border 8×6 m
        </label>
        <label className="inlineCheck">
          <input type="checkbox" checked={showAnchors} onChange={(e) => onShowAnchors(e.target.checked)} />
          Anchors
        </label>
        <label className="inlineCheck">
          <input type="checkbox" checked={showGrid} onChange={(e) => onShowGrid(e.target.checked)} />
          Grid 1×1 m
        </label>
        <label className="inlineCheck">
          <input type="checkbox" checked={smoothTrajectory} onChange={(e) => onSmoothTrajectory(e.target.checked)} />
          Plot smoothing
        </label>
        {smoothTrajectory ? (
          <>
            <label className="inlineCheck">
              <input type="checkbox" checked={smoothOnlySeeker} onChange={(e) => onSmoothOnlySeeker(e.target.checked)} />
              Seeker P1 only
            </label>
            <label className="miniAlphaLabel">
              α {alpha.toFixed(2)}
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={alpha}
                onChange={(e) => onAlpha(Number(e.target.value))}
              />
            </label>
          </>
        ) : null}
      </div>
      <div className="miniTrajGrid">
          {cells.map((cell) => {
            const phasePayloads = cell.phases
              .map((cp) => {
                const id = chosenId(cell, cp);
                const payload = id !== null ? payloads.get(id) : undefined;
                return payload ? { phase: cp.phase, payload } : null;
              })
              .filter((p): p is { phase: PhaseName; payload: SessionPayload } => p !== null);
            const anySession = cell.phases.some((cp) => cp.all.length > 0);
            const explorationCp = cell.phases.find((cp) => cp.phase === 'exploration')!;
            const explorationId = chosenId(cell, explorationCp);
            const trialRow = trialRows.find((r) =>
              r.condition === cell.condition && r.path_id === cell.path && r.exploration_session_id === explorationId
            ) ?? null;
            const explorationMetrics = phasePayloads.find((p) => p.phase === 'exploration')?.payload.metrics ?? null;

            const annKey = `${cell.condition}|${cell.path}|${explorationId ?? 'none'}`;
            const override = annotationOverrides[annKey];
            const effectiveManualLost = override ? override.manual_lost : (trialRow?.manual_lost ?? null);
            const effectiveComment = override ? override.comment : (trialRow?.comment ?? '');
            const effectiveExcluded = override ? override.excluded_from_stats : (trialRow?.excluded_from_stats ?? false);
            const effectiveRow = trialRow ? {
              ...trialRow,
              manual_lost: effectiveManualLost,
              got_lost: effectiveManualLost !== null ? effectiveManualLost : trialRow.got_lost,
              excluded_from_stats: effectiveExcluded,
            } : null;

            return (
              <div key={`${cell.condition}-${cell.path}`} className="miniTrajCard">
                <div className="miniTrajTitle">
                  <strong>{cell.label}</strong>
                  <span>{cell.path.replace('_', ' ')}</span>
                </div>
                {anySession ? (
                  <>
                    <MiniTrajectory payloads={phasePayloads} showBorder={showBorder} showAnchors={showAnchors} showGrid={showGrid} />
                    <div className="miniTrajStatus">
                      {cell.phases.map((cp) => {
                        const id = chosenId(cell, cp);
                        const session = cp.all.find((s) => s.session_id === id);
                        return (
                          <span key={cp.phase} className="miniTrajPhase">
                            <i style={{ background: phaseColors[cp.phase] }} />
                            {cp.phase}
                            {session ? (
                              <>
                                {isFiniteNumber(session.duration_s) ? ` · ${session.duration_s.toFixed(0)}s` : ''}
                                {!isValidSession(session) ? ' ⚠' : ''}
                                {cp.all.length > 1 ? (
                                  <select
                                    value={id ?? undefined}
                                    title={`${cp.all.length} recordings: pick which to show`}
                                    onChange={(e) => setChoices((prev) => ({
                                      ...prev,
                                      [`${cell.condition}|${cell.path}|${cp.phase}`]: Number(e.target.value),
                                    }))}
                                  >
                                    {cp.all.map((s) => (
                                      <option key={s.session_id} value={s.session_id}>
                                        {timeLabel(s.start_time)}{!isValidSession(s) ? ' (lost)' : ''}
                                      </option>
                                    ))}
                                  </select>
                                ) : null}
                              </>
                            ) : (
                              <em> · none recorded</em>
                            )}
                          </span>
                        );
                      })}
                    </div>
                    <TrialMiniStats row={effectiveRow} metrics={explorationMetrics} />
                    <TrialAnnotationEditor
                      patient={patient}
                      condition={cell.condition}
                      pathId={cell.path}
                      explorationSessionId={explorationId}
                      manualLost={effectiveManualLost}
                      comment={effectiveComment}
                      excludedFromStats={effectiveExcluded}
                      onSaved={(next) => {
                        setAnnotationOverrides((prev) => ({ ...prev, [annKey]: next }));
                        onAnnotationSaved?.({
                          condition: cell.condition,
                          pathId: cell.path,
                          explorationSessionId: explorationId,
                          excludedFromStats: next.excluded_from_stats,
                        });
                      }}
                    />
                  </>
                ) : (
                  <div className="miniTrajEmpty">No session recorded for this condition/path.</div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );

  if (bare) return gridBody;

  return (
    <section className="card span2 conditionGridCard">
      <div className="cardHeader">
        <div>
          <strong>Learning vs exploration — all trials ({patient})</strong>
          <small>{cells.length} charts: one per condition × path, with the aggregated trial metrics for the selected attempt.</small>
        </div>
        {loading ? <RefreshCw size={15} className="spin" /> : null}
      </div>
      {gridBody}
    </section>
  );
}
