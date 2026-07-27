import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchSessionDetail } from '../api';
import type { MetricSummary, SessionPayload, SessionRow, TrackingPoint, TrialRow } from '../types';

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

interface Props {
  sessions: SessionRow[];
  patient: string;
  alpha: number;
  smoothTrajectory: boolean;
  smoothOnlySeeker: boolean;
  trialRows: TrialRow[];
  /** Skip the outer card + header — for embedding inside a per-patient
   * collapsible section that already provides its own title. */
  bare?: boolean;
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

/** Room (rotated 90°) → mini SVG coordinates. */
function toSvg(x: number, y: number) {
  const px = y / ROOM_Y; // display X: original y, 0..12
  const py = (ROOM_X - x) / ROOM_X; // display Y: rotated x, 0..8
  return {
    x: MARGIN + px * (MINI_W - 2 * MARGIN),
    y: MARGIN + (1 - py) * (MINI_H - 2 * MARGIN),
  };
}

function seekerPolyline(payload: SessionPayload): { d: string; start?: { x: number; y: number }; end?: { x: number; y: number } } {
  const seeker = payload.config.seeker_id;
  const pts = payload.tracking
    .filter((p: TrackingPoint) => p.tag_id === seeker && isFiniteNumber(p.x_plot) && isFiniteNumber(p.y_plot) && isFiniteNumber(p.t_s))
    .sort((a, b) => a.t_s - b.t_s)
    .map((p) => toSvg(p.x_plot as number, p.y_plot as number));
  if (!pts.length) return { d: '' };
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
  return { d, start: pts[0], end: pts[pts.length - 1] };
}

function targetMarkers(payload: SessionPayload) {
  const targets = payload.config.target_ids ?? [];
  return targets.map((tid) => {
    const pts = payload.tracking.filter((p) => p.tag_id === tid && isFiniteNumber(p.x) && isFiniteNumber(p.y));
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x as number).sort((a, b) => a - b);
    const ys = pts.map((p) => p.y as number).sort((a, b) => a - b);
    const med = toSvg(xs[xs.length >> 1], ys[ys.length >> 1]);
    return { id: tid, ...med };
  }).filter((m): m is { id: string; x: number; y: number } => m !== null);
}

function MiniTrajectory({ payloads }: { payloads: Array<{ phase: PhaseName; payload: SessionPayload }> }) {
  const targets = payloads.length ? targetMarkers(payloads[0].payload) : [];
  return (
    <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} className="miniTrajSvg">
      <rect x={MARGIN} y={MARGIN} width={MINI_W - 2 * MARGIN} height={MINI_H - 2 * MARGIN}
        fill="none" stroke="var(--border)" strokeWidth={1} rx={3} />
      {targets.map((t) => (
        <g key={t.id}>
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
            {start ? <circle cx={start.x} cy={start.y} r={3.4} fill="var(--surface)" stroke={color} strokeWidth={1.6} /> : null}
            {end ? <circle cx={end.x} cy={end.y} r={3.4} fill={color} /> : null}
          </g>
        );
      })}
    </svg>
  );
}

export function TrialMiniStats({ row, metrics }: { row: TrialRow | null; metrics?: MetricSummary | null }) {
  const stats: Array<[string, string]> = row ? [
    ['Overlap', fmt(row.overlap_pct, 0, '%')],
    ['Turn dev', fmt(row.mean_turn_deviation_deg, 0, '°')],
    ['Wrong turns', row.wrong_turns_count != null ? String(row.wrong_turns_count) : '—'],
    ['Stop Δ', fmt(row.stop_position_distance_m, 2, ' m')],
    ['Start Δ', fmt(row.start_position_distance_m, 2, ' m')],
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
          <div key={label}><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
      {row?.got_lost ? <span className="warningBadge miniLostBadge">lost / disrupted attempt</span> : null}
      {row?.note ? <div className="miniWarning">{row.note}</div> : null}
    </div>
  );
}

export function ConditionTrajectoriesGrid({ sessions, patient, alpha, smoothTrajectory, smoothOnlySeeker, trialRows, bare = false }: Props) {
  const [payloads, setPayloads] = useState<Map<number, SessionPayload>>(new Map());
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

            return (
              <div key={`${cell.condition}-${cell.path}`} className="miniTrajCard">
                <div className="miniTrajTitle">
                  <strong>{cell.label}</strong>
                  <span>{cell.path.replace('_', ' ')}</span>
                </div>
                {anySession ? (
                  <>
                    <MiniTrajectory payloads={phasePayloads} />
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
                    <TrialMiniStats row={trialRow} metrics={explorationMetrics} />
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
