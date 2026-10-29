import { MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import {
  fetchPerformanceCorrelations, fetchSessionDetail, fetchTaskSplits, fetchTrialRows, invalidateDerivedCaches, refreshIndex,
  saveAnnotation, saveManualInOrder, saveManualTargetFound, saveTargetCoordinate, saveTaskSplit, swapPhase,
} from '../api';
import type { TaskSplit } from '../api';
import { ChartFrame } from './ChartFrame';
import { InfoPopover, InfoSection, Tex } from './InfoPopover';
import { routeLabel } from '../lib/route';
import { conditionLabel } from '../lib/glossary';
import { useEditMode } from '../lib/editMode';
import type {
  MetricSummary, NavMetrics, PerformanceCorrelations, PerformanceScoreDetails, SessionPayload, SessionRow,
  TargetDiscovery, TargetDiscoveryEntry, TrackingPoint, TrialRow,
} from '../types';

// Same purple already used for anchor markers elsewhere in this file — a
// neutral "measurement" color, distinct from the learning/exploration phase
// colors below and from the red used for manual/danger markers.
const DEVIATION_COLOR = '#7a5af8';
// Distinct from DEVIATION_COLOR (used for the hover-linking dashed line) so
// the two overlays never look like the same thing when both are visible.
const IDEAL_PATH_COLOR = '#a3379e';

/** Only this condition's target tags were never tracked (only P1 was) — the
 * manual-coordinate entry form only makes sense to show there. */
const MANUAL_COORDS_CONDITION = 'haptic_on_object_intes';

/** Card styling for the 4 conditions: 2 colors (modality — audio/haptic),
 * crossed with 2 treatments (delivery location — on_object gets an outline
 * only, on_person tints the whole card) so all 4 stay visually distinct
 * without needing 4 separate colors. */
function conditionCardClass(condition: string): string {
  const modality = condition.startsWith('auditory') ? 'Audio' : condition.startsWith('haptic') ? 'Haptic' : null;
  const location = condition.includes('on_object') ? 'Object' : condition.includes('on_person') ? 'Person' : null;
  return modality && location ? `cond${modality}${location}` : '';
}

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
  /** The straight-line "ideal" route (start -> O1 -> O2 -> O3 -> stop, turning
   * at the real tracked target positions) now used as the reference for
   * turn-deviation scoring — off by default, still a new/unvalidated overlay. */
  showIdealPath: boolean;
  onShowIdealPath: (v: boolean) => void;
  alpha: number;
  onAlpha: (v: number) => void;
  smoothTrajectory: boolean;
  onSmoothTrajectory: (v: boolean) => void;
  smoothOnlySeeker: boolean;
  onSmoothOnlySeeker: (v: boolean) => void;
  /** Which recording is picked per `${condition}|${path}|${phase}`, lifted up
   * (not local state) so it survives this grid unmounting when the dropdown
   * closes, and so General statistics can honor the same manual pick instead
   * of silently defaulting to "latest attempt" behind the researcher's back. */
  choices: Record<string, number>;
  onSetChoice: (condition: string, pathId: string, phase: string, sessionId: number) => void;
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

/** "3 · 6.2 s": number of stops and the time spent stopped. */
function fmtStops(count: number | null | undefined, durationS: number | null | undefined) {
  if (count == null) return '—';
  return durationS == null ? String(count) : `${count} · ${durationS.toFixed(1)} s`;
}

/** "38% · 60%": DTW pairs within 0.5 m and within 1.0 m. */
function fmtMatch(within05: number | null | undefined, within1: number | null | undefined) {
  if (within05 == null || within1 == null) return '—';
  return `${within05.toFixed(0)}% · ${within1.toFixed(0)}%`;
}

function fmtCount(value: number | null | undefined) {
  return value != null ? String(value) : '—';
}

/** Room position as "x, y" in metres. */
function fmtXY(xy: [number, number] | null | undefined) {
  return xy ? `${xy[0].toFixed(1)}, ${xy[1].toFixed(1)}` : '—';
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

/** One seeker sample on the mini map: x/y in SVG units, rawX/rawY the plotted
 * (possibly smoothed) room position, posX/posY the position as logged. */
type MiniEndpoint = { x: number; y: number; rawX: number; rawY: number; posX: number | null; posY: number | null; t: number };

function seekerPoints(payload: SessionPayload): MiniEndpoint[] {
  const seeker = payload.config.seeker_id;
  return payload.tracking
    .filter((p: TrackingPoint) => p.tag_id === seeker && isFiniteNumber(p.x_plot) && isFiniteNumber(p.y_plot) && isFiniteNumber(p.t_s))
    .sort((a, b) => a.t_s - b.t_s)
    .map((p) => ({
      ...toSvg(p.x_plot as number, p.y_plot as number),
      rawX: p.x_plot as number,
      rawY: p.y_plot as number,
      posX: isFiniteNumber(p.x) ? p.x : null,
      posY: isFiniteNumber(p.y) ? p.y : null,
      t: p.t_s,
    }));
}

function pointsPath(pts: MiniEndpoint[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
}

/** Index of the last sample at or before t (0 when t precedes the recording). */
function indexAtTime(pts: MiniEndpoint[], t: number): number {
  let idx = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].t <= t) idx = i; else break;
  }
  return idx;
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

function MiniTrajectory({
  payloads, showBorder, showAnchors, showGrid, manualTargets, suppressTrackedTargetIds,
  idealPath, learnResampledXY, expResampledXY, hoverIndex, splits, pickPhase, onPick,
}: {
  payloads: Array<{ phase: PhaseName; payload: SessionPayload }>;
  showBorder: boolean;
  showAnchors: boolean;
  showGrid: boolean;
  /** The straight-line reference route (start -> O1 -> O2 -> O3 -> stop) now
   * used for turn-deviation scoring, drawn as a dashed overlay when the
   * "Ideal path" toggle is on — independent of how the person actually
   * walked, so it never moves when you switch the selected attempt. */
  idealPath?: [number, number][] | null;
  /** Targets with no sensor data (e.g. haptic_on_object_intes) whose position
   * was entered by hand — drawn in red so they're never mistaken for a
   * measured one. Skipped for any target_id tracking already has a marker for. */
  manualTargets?: Array<{ target_id: string; x: number; y: number }>;
  /** Target ids to never draw the auto-tracked marker for, even if a raw
   * position happens to exist — e.g. haptic_on_object_intes logs a single
   * static ping per target tag, but the researcher says that hardware never
   * reliably tracked O1/O2/O3, so the manual entry should always win. */
  suppressTrackedTargetIds?: string[];
  /** The 100 arc-length-resampled points backing the Deviation profile chart
   * — needed to show, on the map, exactly which physical point corresponds
   * to the position currently hovered on that chart. */
  learnResampledXY?: [number, number][] | null;
  expResampledXY?: [number, number][] | null;
  /** Index (0..99) into learnResampledXY/expResampledXY currently hovered on
   * the Deviation profile chart, or null when not hovering. */
  hoverIndex?: number | null;
  /** Time (s) of the marked point E per phase: the route is drawn solid up to
   * it and dashed after it (the walk back to the start). */
  splits?: Partial<Record<PhaseName, number | null>>;
  /** When set, the map is in "pick point E" mode for that phase's trajectory:
   * the nearest sample follows the mouse and a click reports it. */
  pickPhase?: PhaseName | null;
  onPick?: (pt: MiniEndpoint) => void;
}) {
  const [pickCandidate, setPickCandidate] = useState<MiniEndpoint | null>(null);
  const pickPayload = pickPhase ? payloads.find((p) => p.phase === pickPhase)?.payload : undefined;
  const pickPoints = pickPayload ? seekerPoints(pickPayload) : [];
  const nearestPickPoint = (e: ReactMouseEvent<SVGSVGElement>): MiniEndpoint | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height || !pickPoints.length) return null;
    const mx = ((e.clientX - rect.left) / rect.width) * MINI_W;
    const my = ((e.clientY - rect.top) / rect.height) * MINI_H;
    let best = pickPoints[0];
    let bestD = Infinity;
    for (const p of pickPoints) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };
  const trackedTargets = (payloads.length ? targetMarkers(payloads[0].payload) : [])
    .filter((t) => !suppressTrackedTargetIds?.includes(t.id));
  const manualMarkers = (manualTargets ?? [])
    .filter((mt) => !trackedTargets.some((t) => t.id === mt.target_id))
    .map((mt) => ({ id: mt.target_id, rawX: mt.x, rawY: mt.y, ...toSvg(mt.x, mt.y), isManual: true as const }));
  const targets = [...trackedTargets.map((t) => ({ ...t, isManual: false as const })), ...manualMarkers];
  const anchors = showAnchors && payloads.length ? anchorMarkers(payloads[0].payload) : [];
  const borderRect = showBorder ? borderRectSvg(payloads[0]?.payload) : null;
  return (
    <svg
      viewBox={`0 0 ${MINI_W} ${MINI_H}`}
      className={`miniTrajSvg${pickPhase ? ' picking' : ''}`}
      onMouseMove={pickPhase ? (e) => setPickCandidate(nearestPickPoint(e)) : undefined}
      onMouseLeave={pickPhase ? () => setPickCandidate(null) : undefined}
      onClick={pickPhase ? (e) => { const pt = nearestPickPoint(e); if (pt) onPick?.(pt); } : undefined}
    >
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
          <title>{`${t.id}: x=${t.rawX.toFixed(2)} m, y=${t.rawY.toFixed(2)} m${t.isManual ? ' (manually entered — no sensor data)' : ''}`}</title>
          <path d={`M${t.x - 4},${t.y - 4}L${t.x + 4},${t.y + 4}M${t.x - 4},${t.y + 4}L${t.x + 4},${t.y - 4}`}
            stroke={t.isManual ? '#d92d20' : 'currentColor'} strokeWidth={t.isManual ? 1.8 : 1.4} opacity={t.isManual ? 0.9 : 0.55} />
          <text x={t.x + 6} y={t.y - 4} fontSize={9} fill={t.isManual ? '#d92d20' : 'currentColor'} opacity={t.isManual ? 0.95 : 0.6}>{t.id}</text>
        </g>
      ))}
      {idealPath && idealPath.length >= 2 ? (() => {
        const pts = idealPath.map(([x, y]) => toSvg(x, y));
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
        return (
          <g className="miniIdealPath">
            <title>Percorso ideale a linee rette (start → O1 → O2 → O3 → stop) — il riferimento usato per il calcolo di Route efficiency.</title>
            <path d={d} fill="none" stroke={IDEAL_PATH_COLOR} strokeWidth={1.6} strokeDasharray="5 3.5" opacity={0.85} />
          </g>
        );
      })() : null}
      {payloads.map(({ phase, payload }) => {
        const pts = seekerPoints(payload);
        if (!pts.length) return null;
        const start = pts[0];
        const end = pts[pts.length - 1];
        const color = phaseColors[phase];
        const splitT = splits?.[phase];
        const splitIdx = splitT != null ? indexAtTime(pts, splitT) : null;
        const ePt = splitIdx != null ? pts[splitIdx] : null;
        return (
          <g key={phase}>
            {splitIdx != null ? (
              <>
                <path d={pointsPath(pts.slice(0, splitIdx + 1))} fill="none" stroke={color} strokeWidth={1.6} opacity={0.85} />
                <path d={pointsPath(pts.slice(splitIdx))} fill="none" stroke={color} strokeWidth={1.4} opacity={0.6} strokeDasharray="3 3" />
              </>
            ) : (
              <path d={pointsPath(pts)} fill="none" stroke={color} strokeWidth={1.6} opacity={0.85} />
            )}
            {ePt ? (
              <g className="miniAnchorMarker">
                <title>{`${phase} point E (end of route, start of return): t=${ePt.t.toFixed(1)}s, x=${ePt.rawX.toFixed(2)} m, y=${ePt.rawY.toFixed(2)} m`}</title>
                <rect x={ePt.x - 4} y={ePt.y - 4} width={8} height={8} transform={`rotate(45 ${ePt.x} ${ePt.y})`}
                  fill="var(--surface)" stroke={color} strokeWidth={1.8} />
                <text x={ePt.x + 7} y={ePt.y + 3} fontSize={9} fontWeight={700} fill={color}>E</text>
              </g>
            ) : null}
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
      {hoverIndex != null && learnResampledXY?.[hoverIndex] && expResampledXY?.[hoverIndex] ? (() => {
        const lp = toSvg(learnResampledXY[hoverIndex][0], learnResampledXY[hoverIndex][1]);
        const ep = toSvg(expResampledXY[hoverIndex][0], expResampledXY[hoverIndex][1]);
        return (
          <g className="miniHoverMarkers">
            <line x1={lp.x} y1={lp.y} x2={ep.x} y2={ep.y} stroke={DEVIATION_COLOR} strokeWidth={1.2} strokeDasharray="3 2" />
            <circle cx={lp.x} cy={lp.y} r={5} fill="none" stroke={phaseColors.learning} strokeWidth={2} />
            <circle cx={ep.x} cy={ep.y} r={5} fill="none" stroke={phaseColors.exploration} strokeWidth={2} />
          </g>
        );
      })() : null}
      {pickPhase && pickCandidate ? (
        <g pointerEvents="none">
          <circle cx={pickCandidate.x} cy={pickCandidate.y} r={5.5} fill="none" stroke={phaseColors[pickPhase]} strokeWidth={2} />
          <text x={pickCandidate.x + 8} y={pickCandidate.y - 6} fontSize={9} fontWeight={700} fill="currentColor">
            {`t=${pickCandidate.t.toFixed(1)}s`}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

/** Mark point E on one trial card: the moment the participant ends the route
 * and starts walking back to the starting point. Saved per recording. */
function TaskSplitEditor({
  phases, phase, onPhase, points, savedT, draftT, onDraftT, picking, onPicking, onCommit, saving, error, marks,
}: {
  /** Saved point E time per recording of the trial (null = not marked). */
  marks: Partial<Record<PhaseName, number | null>>;
  phases: PhaseName[];
  phase: PhaseName;
  onPhase: (p: PhaseName) => void;
  points: MiniEndpoint[];
  savedT: number | null;
  draftT: number | null;
  onDraftT: (t: number | null) => void;
  picking: boolean;
  onPicking: (v: boolean) => void;
  onCommit: (t: number | null) => void;
  saving: boolean;
  error: string | null;
}) {
  if (points.length < 2) return null;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const shownT = draftT ?? savedT;
  return (
    <div className="miniSplit">
      <div className="miniCoordFormTitle">
        Point E — end of route
        <InfoPopover>
          <h4>Point E</h4>
          <p>Marks the moment the participant ends the route (the hypothetical end point E) and starts the second task, walking back to the starting point.</p>
          <p>Click <strong>Pick on map</strong> and then the trajectory, or drag the slider to move along the recording in time. The route is drawn solid up to E and dashed after it.</p>
          <p>The mark is saved per recording and does not change any metric.</p>
        </InfoPopover>
      </div>
      <div className="miniSplitRow">
        {phases.length > 1 ? (
          <select value={phase} onChange={(e) => onPhase(e.target.value as PhaseName)} title="Which recording to mark">
            {phases.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : <span className="miniHintInline">{phase}</span>}
        <button
          type="button"
          className={`miniPhaseSwapBtn${picking ? ' active' : ''}`}
          onClick={() => onPicking(!picking)}
          disabled={saving}
        >
          {picking ? 'Click the route… (cancel)' : 'Pick on map'}
        </button>
        <span className="miniHintInline">
          {shownT != null ? `E at t = ${shownT.toFixed(1)} s` : 'not set'}{saving ? ' · saving…' : ''}
        </span>
        {savedT != null ? (
          <button type="button" className="miniPhaseSwapBtn" onClick={() => onCommit(null)} disabled={saving}>Clear</button>
        ) : null}
      </div>
      <input
        type="range"
        aria-label={`Point E time, ${phase} recording`}
        min={t0}
        max={t1}
        step={0.1}
        value={shownT ?? t1}
        onChange={(e) => onDraftT(Number(e.target.value))}
        onPointerUp={() => { if (draftT != null) onCommit(draftT); }}
        onKeyUp={() => { if (draftT != null) onCommit(draftT); }}
      />
      <span className="miniHintInline">
        {PHASES.map((p) => `${p}: ${marks[p] != null ? `marked (${(marks[p] as number).toFixed(1)} s)` : 'not marked'}`).join(' · ')}
      </span>
      {error ? <span className="miniSavingHint miniSavingError">{error}</span> : null}
    </div>
  );
}

// d_i, p_i, q_j etc. rendered as real subscripts, not underscore text.
function Sub({ base, sub }: { base: string; sub: string }) {
  return <>{base}<sub>{sub}</sub></>;
}

// Each of the 5 route-similarity measures gets its OWN card — its own
// definition and formula, not the same shared page repeated 5 times. A short
// "vs. the others" line at the end cross-references the rest for context.
const RESAMPLE_NOTE = 'Both routes (learning P1 trajectory and exploration P1 trajectory) are first resampled to 100 points equally spaced by arc length — distance traveled, not time — so point k always means "k% of the way along the route" regardless of walking speed.';

const OVERLAP_INFO = (
  <>
    <h4>Overlap</h4>
    <p>Share of exploration points that fall within 0.5 m of ANY point on the raw (un-resampled) learning route — nearest-neighbor distance, order-blind. A thresholded, one-sided relative of the{' '}
      <a href="https://en.wikipedia.org/wiki/Hausdorff_distance" target="_blank" rel="noreferrer">Hausdorff distance</a> used to compare shapes/point-sets.
    </p>
    <Tex tex={String.raw`d_i = \min_j\ \mathrm{dist}(exp_i,\ learn_j)`} />
    <Tex tex={String.raw`\text{Overlap} \% = 100 \times \dfrac{\left|\{\,i : d_i \le 0.5\text{m}\,\}\right|}{N}`} />
    <p>Measures "stayed in the area the learning route covered" — can be high even for a very different-shaped or backtracking route, since a winding learning route sweeps a wide corridor. For an order-respecting version, see Shape overlap.</p>
  </>
);

const SHAPE_OVERLAP_INFO = (
  <>
    <h4>Shape overlap / Shape deviation</h4>
    <p className="statInfoIntro">{RESAMPLE_NOTE}</p>
    <p>Compares point k of learning to point k of exploration, for k = 1..100 — same relative position along each route.</p>
    <Tex tex={String.raw`d_k = \mathrm{dist}(learn_k,\ exp_k)`} />
    <Tex tex={String.raw`\text{Shape overlap} \% = 100 \times \dfrac{\left|\{\,k : d_k \le 0.5\text{m}\,\}\right|}{100}`} />
    <Tex tex={String.raw`\text{Shape dev (m)} = \dfrac{1}{100}\sum_{k=1}^{100} d_k`} />
    <p>Unlike Overlap, wandering the same area without retracing the route in order scores low here.</p>
  </>
);

const FRECHET_INFO = (
  <>
    <h4>Fréchet distance</h4>
    <p className="statInfoIntro">{RESAMPLE_NOTE} Discrete{' '}
      <a href="https://en.wikipedia.org/wiki/Fr%C3%A9chet_distance" target="_blank" rel="noreferrer">Fréchet distance</a> (Eiter &amp; Mannila, 1994).
    </p>
    <p>The shortest "leash" connecting a walker on the learning route to a walker on the exploration route, if both may only move forward (never back), each pacing themselves to minimize the longest leash needed at any moment.</p>
    <Tex tex={String.raw`ca(0,0) = d(0,0)`} />
    <Tex tex={String.raw`ca(i,0) = \max\big(ca(i-1,0),\ d(i,0)\big)`} />
    <Tex tex={String.raw`ca(0,j) = \max\big(ca(0,j-1),\ d(0,j)\big)`} />
    <Tex tex={String.raw`ca(i,j) = \max\Big(d(i,j),\ \min\big(ca(i-1,j),\ ca(i-1,j-1),\ ca(i,j-1)\big)\Big)`} />
    <Tex tex={String.raw`\text{result} = ca(99,99)`} />
    <p>A worst-case number: a single bad detour raises it for the WHOLE trial even if every other point matches closely — the most sensitive of the five route-similarity measures to one outlier moment.</p>
  </>
);

const DTW_INFO = (
  <>
    <h4>DTW — Dynamic Time Warping</h4>
    <p className="statInfoIntro">{RESAMPLE_NOTE} See{' '}
      <a href="https://en.wikipedia.org/wiki/Dynamic_time_warping" target="_blank" rel="noreferrer">Dynamic time warping</a>.
    </p>
    <p>The cheapest total alignment cost, letting one point match several consecutive points on the other route (stretching/compressing in time) instead of a rigid same-index pairing — normalized to an average cost per step.</p>
    <Tex tex={String.raw`dtw(0,0) = 0`} />
    <Tex tex={String.raw`dtw(i,j) = d(i,j) + \min\big(dtw(i-1,j),\ dtw(i-1,j-1),\ dtw(i,j-1)\big)`} />
    <Tex tex={String.raw`\text{result} = \dfrac{dtw(100,100)}{100}`} />
    <p>Tolerates pacing differences (a pause, a slightly longer detour that ends up in the same place) that would misalign Shape deviation's rigid same-index comparison. Unlike Fréchet, it averages over every point rather than being dominated by the single worst one.</p>
  </>
);

const LCSS_INFO = (
  <>
    <h4>LCSS — Longest Common Subsequence</h4>
    <p className="statInfoIntro">{RESAMPLE_NOTE} Trajectory adaptation of the{' '}
      <a href="https://en.wikipedia.org/wiki/Longest_common_subsequence" target="_blank" rel="noreferrer">longest common subsequence</a> problem, matching within a distance threshold instead of exact equality.
    </p>
    <p>The longest run of matched point-pairs (within 0.5 m), freely SKIPPING any number of unmatched points on either side instead of penalizing them — normalized by the shorter route's length (100, since both are resampled to 100).</p>
    <Tex tex={String.raw`lcss(i,j) = lcss(i-1,j-1) + 1 \quad \text{if } d(i,j) \le 0.5\text{m}`} />
    <Tex tex={String.raw`lcss(i,j) = \max\big(lcss(i-1,j),\ lcss(i,j-1)\big) \quad \text{otherwise}`} />
    <Tex tex={String.raw`\text{result} = 100 \times \dfrac{lcss(100,100)}{\min(100,100)}`} />
    <p>The most forgiving of the five: a single bad detour is simply skipped, not scored — unlike Overlap, Shape overlap, Fréchet, and DTW, which all score every point.</p>
  </>
);

const STAT_INFO: Record<string, ReactNode> = {
  'Overlap': OVERLAP_INFO,
  'Shape overlap': SHAPE_OVERLAP_INFO,
  'Fréchet': FRECHET_INFO,
  'DTW': DTW_INFO,
  'LCSS': LCSS_INFO,
  'Stop Δ': <p>Distance from the end point: between the point E marked on the learning recording and the point E marked on the exploration recording (x, y in metres). Empty until both are marked.</p>,
  'Tags found': <p>Landmark units found during the first task of the exploration recording: first signal at or before the marked point E, with whether they were found in the taught order. A find confirmed by hand has no time and is counted. Empty until point E is marked.</p>,
  'DTW match': <p>How much of the route walked from memory corresponds to the taught one: DTW pairs each point of the learning route (the first task, cut at point E) with the best-matching point of the exploration route; this is the share of those pairs that lie within 0.5 m · within 1.0 m of each other.</p>,
  'DTW match return': <p>Same correspondence index for the two walks back (the second task): share of the DTW-matched pairs within 0.5 m · within 1.0 m.</p>,
  'DTW return': <p>DTW between the two walks back: the second task of the learning recording and the second task of the exploration recording, each cut from its own marked point E to its end and resampled to 100 points. The two walks start from different points E, so this value also carries the end-point error of the first task. Empty until both points are marked.</p>,
  'Route S→E': <p>First task of the exploration recording, from its start to the marked point E: trajectory length on the horizontal plane, duration, and speed (length ÷ duration). Empty until point E is marked.</p>,
  'Return E→S': <p>Second task of the exploration recording, from the marked point E to its end: trajectory length on the horizontal plane, duration, and speed (length ÷ duration). Empty until point E is marked.</p>,
  'Learning S→E': <p>First task of the learning recording, from its start to its own marked point E: length, duration and speed. Empty until point E is marked on the learning recording.</p>,
  'Learning E→S': <p>Second task of the learning recording, from its own marked point E to its end: length, duration and speed. Empty until point E is marked on the learning recording.</p>,
  'Start Δ': <p>Distance between the learning recording's first tracked position (the taught starting point S) and the exploration's first tracked position (x, y in metres).</p>,
  'Stops': <p>Number of pauses during this exploration attempt: stretches of at least 1 s in which the hand-held unit P1 stays within 0.141 m (its position error) of where the pause started (stay points, Li et al. 2008). Data gaps are never pauses. Inside First task / Second task: only the pauses that start before / after the marked point E.</p>,
  'Border': <p>Number of times the participant stepped outside the centered 8×6 m safety box during this exploration attempt. A crossing counts when the hand-held unit goes more than 0.141 m (its position error) outside the box; the next one only after it has come back more than 0.141 m inside. Inside First task / Second task: only the crossings that start before / after the marked point E.</p>,
  'Impacts': <p>Probable physical hits on the landmark units (their acceleration spiking above the resting level) during this exploration attempt. Inside First task / Second task: only the hits that start before / after the marked point E.</p>,
  'Duration': <p>Length of this exploration attempt.</p>,
  'Mean speed': <p>Walking speed during this exploration attempt: trajectory length on the horizontal plane divided by the duration of the recording.</p>,
  'Data gaps': <p>Stretches where the position of P1 stays exactly the same for 1 s or more: the tracking stopped updating, so these are holes in the data, not pauses. Shown as count · total duration; they are left out of the pauses.</p>,
  'Data gaps (learning)': <p>Same data gaps on the learning recording of this trial.</p>,
  'Pause time': <p>Total time spent in pauses (P1 within 0.141 m for at least 1 s) during this task of the exploration attempt. A pause that runs across the marked point E is shared between the two tasks by the time it spends in each.</p>,
  'Pauses (learning)': <p>Same pauses on the learning recording of this trial: how many start in this task and the time spent stopped in it.</p>,
  'Movement': <p>Movement intensity of the exploration attempt: mean of the size of the hand-held unit’s linear acceleration (m/s²), leaving out the samples at zero (sensor not active). Higher means the hand moved more — sweeping, turning, hesitating.</p>,
  'Movement (learning)': <p>Same movement intensity on the learning recording of this trial.</p>,
  'Min closest': <p>Closest distance reached to any landmark unit during the first task of this exploration attempt (up to the marked point E), measured on the horizontal plane (x, y) like the route length — the height of the hand-held unit is left out. Empty until point E is marked.</p>,
  'Return Δ': <p>Return distance: between the learning recording's FIRST tracked position (the taught starting point S) and the exploration's LAST tracked position — how far from S the walk back ended (x, y in metres).</p>,
  'Found': <p>How many of the trial's landmarks (O1/O2/O3) triggered at least one feedback event during this exploration attempt, out of how many were placed on this route. "in order"/"out of order" compares the order they were first triggered against the route's intended visit order (from the learning session).</p>,
};

function fmtFound(td: TargetDiscovery | null): string {
  if (!td) return '—';
  const total = td.targets.length;
  if (!total) return '—';
  const orderTag = td.found_count === 0 ? '' : td.in_order ? ' (in order)' : ' (out of order)';
  return `${td.found_count}/${total}${orderTag}`;
}

/** Where along the route (not just "how much on average") did learning and
 * exploration diverge — the per-point d_k behind Shape overlap/Shape dev,
 * charted instead of collapsed into a single mean. Hovering reports the
 * hovered index up so the map above can highlight that exact point. */
function DeviationProfileChart({
  profile, onHoverIndex,
}: {
  profile: number[] | null;
  onHoverIndex?: (k: number | null) => void;
}) {
  if (!profile || !profile.length) return null;
  const data = profile.map((deviation, i) => ({ pct: i, deviation }));
  return (
    <div className="miniDeviationChart">
      <div className="miniDeviationChartTitle">
        Deviation profile
        <InfoPopover>
          <h4>Deviation profile</h4>
          <p>Distance between the learning and exploration routes at each relative position along the route — the same 100 arc-length-resampled points (k = 0..99) used for Shape overlap/DTW, charted instead of collapsed into one average.</p>
          <p>Shows WHERE along the route the two diverged (e.g. a spike near a turn or a landmark), not just how much on average. The mean of this curve equals "Shape dev" in the stats above.</p>
          <p>Hover the chart to highlight the matching point on the map above (learning in blue, exploration in orange).</p>
        </InfoPopover>
      </div>
      <ChartFrame height={130} minWidth={260} minHeight={110}>{(width, height) => (
        <AreaChart
          width={width} height={height} data={data} margin={{ top: 6, right: 8, bottom: 2, left: 0 }}
          onMouseMove={(state) => {
            const idx = typeof state?.activeTooltipIndex === 'number' ? state.activeTooltipIndex : null;
            onHoverIndex?.(idx);
          }}
          onMouseLeave={() => onHoverIndex?.(null)}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="pct" tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}%`} interval={24} />
          <YAxis unit="m" tick={{ fontSize: 9 }} width={32} />
          <Tooltip
            animationDuration={0}
            isAnimationActive={false}
            labelFormatter={(v: unknown) => `${v}% along route`}
            formatter={(v: unknown) => (typeof v === 'number' ? [`${v.toFixed(2)} m`, 'Deviation'] : ['—', 'Deviation'])}
          />
          <Area
            type="monotone"
            dataKey="deviation"
            stroke={DEVIATION_COLOR}
            fill={DEVIATION_COLOR}
            fillOpacity={0.25}
            strokeWidth={1.6}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      )}</ChartFrame>
    </div>
  );
}

/** key in PerformanceCorrelations['correlations'] -> human label, in the
 * same order the backend computes them (speed then acceleration, each
 * against endpoint/target/border in that order). */
const CORRELATION_LABELS: Record<string, string> = {
  speed_vs_endpoint_distance: 'Mean speed vs. distance to end point',
  speed_vs_target_distance: 'Mean speed vs. avg. distance to each landmark',
  speed_vs_targets_found: 'Mean speed vs. fraction of landmarks reached',
  speed_vs_border_crossings: 'Mean speed vs. border crossings',
  accel_vs_endpoint_distance: 'Peak acceleration vs. distance to end point',
  accel_vs_target_distance: 'Peak acceleration vs. avg. distance to each landmark',
  accel_vs_targets_found: 'Peak acceleration vs. fraction of landmarks reached',
  accel_vs_border_crossings: 'Peak acceleration vs. border crossings',
};

function fmtR(r: number | null | undefined): string {
  return typeof r === 'number' ? (r >= 0 ? `+${r.toFixed(2)}` : r.toFixed(2)) : '—';
}

/** Whole-count units (a number of crossings, or "N of M" found) read oddly
 * with 2 decimal places ("0.00 crossings") — only distances (meters) get
 * the decimal formatting. */
function fmtRaw(value: number | null, unit: string): string {
  if (value == null) return '—';
  return unit === 'm' ? `${value.toFixed(2)} ${unit}` : `${Math.round(value)} ${unit}`.trim();
}

/** Content of the Performance info popover: the variables/weights behind
 * THIS trial's score — including the O1/O2/O3 breakdown behind the averaged
 * "Target proximity" component, since an average alone hides a trial that
 * nailed one target and never went near the other two — plus the
 * dataset-wide speed/acceleration correlation check that's the actual
 * justification for leaving them out of the formula (see
 * compute_speed_accel_correlations on the backend). */
function PerformanceInfo({
  details, correlations,
}: {
  details: PerformanceScoreDetails;
  correlations: PerformanceCorrelations | null;
}) {
  const corrEntries = correlations ? (Object.entries(correlations.correlations) as [string, number | null][]) : [];
  const strongest = corrEntries.reduce<[string, number] | null>((best, [key, r]) => {
    if (r == null) return best;
    return !best || Math.abs(r) > Math.abs(best[1]) ? [key, r] : best;
  }, null);
  return (
    <>
      <h4>Performance score</h4>
      <p>1-5 rating of how well this exploration attempt achieved the stated goal: end up as close as possible to the learning route's own end point and to EACH landmark (O1-O3) individually, having actually found them, without repeatedly leaving the 8×6 m safety border (a penalty even for an attempt that otherwise finished).</p>
      <p>Normalizing each component to 0–1, weighting, summing, then mapping onto an ordinal scale follows the same general composite-scoring approach as <a href="https://doi.org/10.1016/S0166-4115(08)62386-9" target="_blank" rel="noreferrer">NASA-TLX</a> (Hart &amp; Staveland, 1988) for blending several subscales into one score — cited here as a methodological precedent for the blending technique, not as a validated wayfinding/mobility instrument: the four components and their weights below are our own, not from a published scale.</p>
      <InfoSection heading="Variables used for this trial">
        <ul>
          {details.components.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>: {fmtRaw(c.raw_value, c.unit)} → normalized {c.normalized_score.toFixed(2)}, weight {(c.weight * 100).toFixed(0)}%
            </li>
          ))}
        </ul>
        <p>composite = Σ(weight × normalized) = {details.composite != null ? details.composite.toFixed(2) : '—'} → score = round(1 + 4 × composite) = <strong>{details.score}/5</strong>.</p>
      </InfoSection>
      {details.target_breakdown.length ? (
        <InfoSection heading="Distance to each landmark">
          <ul>
            {details.target_breakdown.map((t) => (
              <li key={t.target_id}>
                <strong>{t.target_id}</strong>: {t.distance_m.toFixed(2)} m — {t.found ? 'found' : 'not found'}
              </li>
            ))}
          </ul>
          <p>"Landmark proximity" above is the mean of these; "Landmarks reached" is how many are marked found here out of {details.target_breakdown.length}.</p>
        </InfoSection>
      ) : null}
      <InfoSection heading="Why not speed/acceleration?">
        <p>Checked for Pearson correlation against outcome across every trial with both a learning and exploration recording (n = {correlations?.n ?? '…'}) before deciding what to weight the score by:</p>
        <ul>
          {corrEntries.map(([key, r]) => <li key={key}>{CORRELATION_LABELS[key]}: r = {fmtR(r)}</li>)}
        </ul>
        {strongest ? (
          <p>The strongest relationship found is <strong>{CORRELATION_LABELS[strongest[0]]}</strong> (r = {fmtR(strongest[1])}) — moderate at best, and border crossings are already a scored component above, so speed/acceleration aren't added as separate weighted inputs.</p>
        ) : <p>Not enough trials with both a speed/acceleration reading and a resolvable outcome yet.</p>}
      </InfoSection>
    </>
  );
}

/** The added "line" in the mini-card: a 1-5 star rating plus an info icon
 * explaining the variables/weights and the speed/acceleration correlation
 * check behind it. Renders nothing when no exploration attempt is selected
 * (details.score is only null then — see compute_performance_score). */
function PerformanceScoreRow({
  details, correlations,
}: {
  details: PerformanceScoreDetails | null;
  correlations: PerformanceCorrelations | null;
}) {
  if (!details || details.score == null) return null;
  const score = details.score;
  return (
    <div className="miniPerformanceRow">
      <span className="miniPerformanceLabel">
        Performance
        <InfoPopover width={440}><PerformanceInfo details={details} correlations={correlations} /></InfoPopover>
      </span>
      <span className="miniPerformanceStars" aria-label={`${score} out of 5`}>
        {'★'.repeat(score)}
        <span className="miniPerformanceStarsEmpty">{'★'.repeat(5 - score)}</span>
      </span>
      <strong className="miniPerformanceValue">{score}/5</strong>
    </div>
  );
}

function fmtPct(v: number | null): string {
  return v != null ? `${v.toFixed(0)}%` : '—';
}

/** Content of the Nav. metrics info popover — each measure named with the
 * literature term it corresponds to (see compute_navigation_metrics on the
 * backend), reported individually with no combining/weighting, shown as an
 * alternative to the heuristic Performance score above for comparison. */
function NavMetricsInfo({ metrics }: { metrics: NavMetrics }) {
  return (
    <>
      <h4>Navigation metrics</h4>
      <p>Four measures reported individually — unlike the Performance score above, nothing here is combined or weighted into a single number. Provenance varies per measure (see each section); not all are verified as named orientation-and-mobility (O&M)/blind-mobility terms.</p>
      <InfoSection heading="Route efficiency">
        <p>Ideal (shortest, waypoint-to-waypoint) route length ÷ actual distance traveled. This exact ratio is "route efficiency" in{' '}
          <a href="https://en.wikipedia.org/wiki/Morris_water_maze" target="_blank" rel="noreferrer">Morris water maze</a> spatial-navigation research (rodent studies); human{' '}
          <a href="https://en.wikipedia.org/wiki/Wayfinding" target="_blank" rel="noreferrer">wayfinding</a> research uses the inverse ("route ratio" = actual/ideal). 100% = as short as geometrically possible.
        </p>
        <Tex tex={String.raw`d_{ideal} = \sum_{i} \mathrm{dist}(\text{waypoint}_i,\ \text{waypoint}_{i+1}) \quad (\text{start} \to O_1 \to O_2 \to O_3 \to \text{stop})`} />
        <Tex tex={String.raw`\text{Route efficiency} \% = 100 \times \dfrac{d_{ideal}}{d_{actual}}`} />
        <p className="statInfoIntro">Every waypoint above — start, O1/O2/O3, stop — is taken from the LEARNING recording's own tracked positions, not some independently defined "ideal" route: <Sub base="d" sub="ideal" /> is the straight-line distance connecting where learning started, visited each landmark, and ended. <Sub base="d" sub="actual" /> is the distance actually walked in the EXPLORATION attempt being scored here.</p>
        <p>{metrics.ideal_path_length_m != null ? metrics.ideal_path_length_m.toFixed(2) : '—'} m ideal ÷ {metrics.actual_path_length_m != null ? metrics.actual_path_length_m.toFixed(2) : '—'} m actual = <strong>{fmtPct(metrics.path_efficiency_pct)}</strong>.</p>
        {metrics.path_efficiency_pct != null && metrics.path_efficiency_pct > 120 ? (
          <p>Above ~100% usually means the attempt was short or interrupted before covering the ideal route — not unusually efficient movement.</p>
        ) : null}
      </InfoSection>
      <InfoSection heading="Landmarks reached">
        <p>Fraction of this route's landmarks actually found (feedback or manual-distance confirmed) — the standard task-success-rate measure in search/assistive-technology studies. A landmark walked past but never triggered still counts as not found here, even if geometrically close.</p>
        <Tex tex={String.raw`\text{Landmarks reached} \% = 100 \times \dfrac{\text{landmarks reached}}{\text{landmarks total}}`} />
        <p><strong>{metrics.targets_found ?? '—'} / {metrics.targets_total ?? '—'}</strong> found ({fmtPct(metrics.target_acquisition_pct)})</p>
        {metrics.target_breakdown.length ? (
          <ul>
            {metrics.target_breakdown.map((t) => (
              <li key={t.target_id}><strong>{t.target_id}</strong>: {t.distance_m.toFixed(2)} m — {t.found ? 'found' : 'not found'}</li>
            ))}
          </ul>
        ) : null}
      </InfoSection>
      <InfoSection heading="Endpoint (homing) error">
        <p>Distance between the final tracked position and the learning route's own end point — the same measure used in classic{' '}
          <a href="https://en.wikipedia.org/wiki/Homing_(biology)" target="_blank" rel="noreferrer">homing</a> / triangle-completion navigation experiments. Only the final position matters, not the route taken.
        </p>
        <Tex tex={String.raw`\text{Endpoint error} = \left\lVert p_{final} - p_{end}^{learning} \right\rVert`} />
        <p><strong>{metrics.endpoint_error_m != null ? `${metrics.endpoint_error_m.toFixed(2)} m` : '—'}</strong></p>
      </InfoSection>
      <InfoSection heading="Boundary contacts">
        <p>Number of times the 8×6 m safety perimeter was left — analogous to "veering incidents" reported in{' '}
          <a href="https://en.wikipedia.org/wiki/Orientation_and_mobility" target="_blank" rel="noreferrer">O&amp;M mobility</a> research on blind pedestrian travel. Counts episodes, not how far or long each excursion was.
        </p>
        <p><strong>{metrics.boundary_contacts ?? '—'}</strong></p>
      </InfoSection>
    </>
  );
}

/** Second, separate line from PerformanceScoreRow above — same underlying
 * facts, reported as unweighted standard measures instead of a composite
 * 1-5, shown side by side so the two can be compared directly. */
function NavMetricsRow({ metrics }: { metrics: NavMetrics | null }) {
  if (!metrics) return null;
  return (
    <div className="miniPerformanceRow miniNavRow">
      <span className="miniPerformanceLabel">
        Nav. metrics
        <InfoPopover width={440}><NavMetricsInfo metrics={metrics} /></InfoPopover>
      </span>
      <span className="miniNavStats">
        <span>Route eff. <strong>{fmtPct(metrics.path_efficiency_pct)}</strong></span>
        <span>Landmarks <strong>{metrics.targets_found ?? '—'}/{metrics.targets_total ?? '—'}</strong></span>
        <span>Homing <strong>{metrics.endpoint_error_m != null ? `${metrics.endpoint_error_m.toFixed(2)} m` : '—'}</strong></span>
        <span>Border <strong>{metrics.boundary_contacts ?? '—'}</strong></span>
      </span>
    </div>
  );
}

export function TrialMiniStats({
  row, metrics, onHoverDeviationIndex,
}: {
  row: TrialRow | null;
  metrics?: MetricSummary | null;
  onHoverDeviationIndex?: (k: number | null) => void;
}) {
  // Fetched once (shared singleton promise in api.ts — see
  // fetchPerformanceCorrelations) no matter how many mini-cards mount at
  // once, since it's the same dataset-wide number for all of them.
  const [correlations, setCorrelations] = useState<PerformanceCorrelations | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchPerformanceCorrelations().then((c) => { if (!cancelled) setCorrelations(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Tags (landmark units) found during task 1: first signal at or before the
  // marked point E. A manually confirmed find has no time and is counted.
  const splitT = row?.exploration_split_t_s ?? null;
  const td = row?.target_discovery ?? null;
  const tagsInTask1 = (() => {
    if (!td || !td.targets.length || splitT == null) return '—';
    const inTask1 = td.targets.filter((t) => t.found && (t.first_feedback_t_s == null || t.first_feedback_t_s <= splitT));
    // Same set as the whole recording: reuse its order (it carries any manual
    // override). Otherwise order the timed finds against the taught order.
    let inOrder: boolean | null = td.in_order;
    if (inTask1.length !== td.found_count) {
      const timed = inTask1.filter((t) => t.first_feedback_t_s != null)
        .sort((x, y) => (x.first_feedback_t_s as number) - (y.first_feedback_t_s as number));
      inOrder = timed.every((t, i) => i === 0 || timed[i - 1].path_order < t.path_order);
    }
    const orderTag = inTask1.length === 0 || inOrder == null ? '' : inOrder ? ' (in order)' : ' (out of order)';
    return `${inTask1.length}/${td.targets.length}${orderTag}`;
  })();
  type Segment = [string, number | null, number | null, number | null];
  type PointRow = { label: string; info: string; learning: [number, number] | null; exploration: [number, number] | null; delta: number | null };
  /** One measure: its value in the exploration phase and, when it exists, in
   * the learning phase of the same trial. Secondary rows are folded away. */
  type MeasureRow = { label: string; info?: string; exploration: string; learning?: string; secondary?: boolean };
  type Group = { title: string; subtitle?: string; task?: boolean; needsE?: boolean; segments?: Segment[]; point?: PointRow; rows: MeasureRow[] };
  const contacts = (n: number | null | undefined) => fmtCount(n);
  const groups: Group[] = row ? [
    {
      title: 'First task',
      subtitle: 'starting point S → end point E',
      task: true,
      needsE: true,
      segments: [
        ['Exploration', row.exploration_task1_length_m, row.exploration_task1_duration_s, row.exploration_task1_speed_m_s],
        ['Learning', row.learning_task1_length_m, row.learning_task1_duration_s, row.learning_task1_speed_m_s],
      ],
      point: {
        label: 'End point (E)', info: 'Stop Δ',
        learning: row.learning_split_xy, exploration: row.exploration_split_xy, delta: row.stop_position_distance_m,
      },
      rows: [
        { label: 'Trajectory distance (DTW)', info: 'DTW', exploration: fmt(row.dtw_distance_m, 2, ' m') },
        { label: 'Correspondence index (0.5 · 1.0 m)', info: 'DTW match', exploration: fmtMatch(row.dtw_match_05m_pct, row.dtw_match_1m_pct) },
        { label: 'Pauses (count · time)', info: 'Stops', exploration: fmtStops(row.exploration_task1_pause_count, row.exploration_task1_pause_duration_s), learning: fmtStops(row.learning_task1_pause_count, row.learning_task1_pause_duration_s) },
        { label: 'Movement intensity', info: 'Movement', exploration: fmt(row.exploration_task1_movement_intensity_m_s2, 2, ' m/s²'), learning: fmt(row.learning_task1_movement_intensity_m_s2, 2, ' m/s²') },
        { label: 'Border crossings', info: 'Border', exploration: fmtCount(row.exploration_task1_border_reached_count) },
        { label: 'Contacts', info: 'Impacts', exploration: contacts(row.exploration_task1_impact_count) },
        { label: 'Landmarks reached', info: 'Tags found', exploration: tagsInTask1 },
        { label: 'Closest distance', info: 'Min closest', exploration: fmt(row.exploration_task1_min_closest_distance_m, 2, ' m') },
        { label: 'Data gaps (count · time)', info: 'Data gaps', exploration: fmtStops(row.exploration_task1_data_gap_count, row.exploration_task1_data_gap_duration_s), learning: fmtStops(row.learning_task1_data_gap_count, row.learning_task1_data_gap_duration_s), secondary: true },
      ],
    },
    {
      title: 'Second task',
      subtitle: 'end point E → starting point S',
      task: true,
      needsE: true,
      segments: [
        ['Exploration', row.exploration_task2_length_m, row.exploration_task2_duration_s, row.exploration_task2_speed_m_s],
        ['Learning', row.learning_task2_length_m, row.learning_task2_duration_s, row.learning_task2_speed_m_s],
      ],
      point: {
        label: 'Return (S)', info: 'Return Δ',
        learning: row.ideal_start_xy, exploration: row.exploration_end_xy ?? null, delta: row.return_to_start_distance_m,
      },
      rows: [
        { label: 'Trajectory distance (DTW)', info: 'DTW return', exploration: fmt(row.dtw_task2_distance_m, 2, ' m') },
        { label: 'Correspondence index (0.5 · 1.0 m)', info: 'DTW match return', exploration: fmtMatch(row.dtw_task2_match_05m_pct, row.dtw_task2_match_1m_pct) },
        { label: 'Pauses (count · time)', info: 'Stops', exploration: fmtStops(row.exploration_task2_pause_count, row.exploration_task2_pause_duration_s), learning: fmtStops(row.learning_task2_pause_count, row.learning_task2_pause_duration_s) },
        { label: 'Movement intensity', info: 'Movement', exploration: fmt(row.exploration_task2_movement_intensity_m_s2, 2, ' m/s²'), learning: fmt(row.learning_task2_movement_intensity_m_s2, 2, ' m/s²') },
        { label: 'Border crossings', info: 'Border', exploration: fmtCount(row.exploration_task2_border_reached_count) },
        { label: 'Contacts', info: 'Impacts', exploration: contacts(row.exploration_task2_impact_count) },
        { label: 'Data gaps (count · time)', info: 'Data gaps', exploration: fmtStops(row.exploration_task2_data_gap_count, row.exploration_task2_data_gap_duration_s), learning: fmtStops(row.learning_task2_data_gap_count, row.learning_task2_data_gap_duration_s), secondary: true },
      ],
    },
    {
      title: 'Whole recording',
      subtitle: 'S → E → S',
      task: true,
      segments: [
        ['Exploration', row.exploration_length_m, row.exploration_duration_s, row.exploration_speed_m_s],
        ['Learning', row.learning_length_m, row.learning_duration_s, row.learning_speed_m_s],
      ],
      point: {
        label: 'Start (S)', info: 'Start Δ',
        learning: row.ideal_start_xy, exploration: row.exploration_start_xy ?? null, delta: row.start_position_distance_m,
      },
      rows: [
        { label: 'Pauses (count · time)', info: 'Stops', exploration: fmtStops(row.exploration_pause_count, row.exploration_pause_duration_s), learning: fmtStops(row.learning_pause_count, row.learning_pause_duration_s) },
        { label: 'Movement intensity', info: 'Movement', exploration: fmt(row.exploration_movement_intensity_m_s2, 2, ' m/s²'), learning: fmt(row.learning_movement_intensity_m_s2, 2, ' m/s²') },
        { label: 'Border crossings', info: 'Border', exploration: fmtCount(row.border_reached_count) },
        { label: 'Contacts', info: 'Impacts', exploration: String(Object.values(row.target_impacts ?? {}).reduce((a, b) => a + b, 0)) },
        { label: 'Landmarks reached', info: 'Found', exploration: fmtFound(row.target_discovery) },
        { label: 'Data gaps (count · time)', info: 'Data gaps', exploration: fmtStops(row.exploration_data_gap_count, row.exploration_data_gap_duration_s), learning: fmtStops(row.learning_data_gap_count, row.learning_data_gap_duration_s), secondary: true },
      ],
    },
  ] : [];
  if (!row && metrics) {
    groups.push({ title: 'Whole recording', rows: [
      { label: 'Duration', info: 'Duration', exploration: fmt(metrics.duration_s, 0, 's') },
      { label: 'Walking speed', info: 'Mean speed', exploration: fmt(metrics.mean_speed_m_s, 2, ' m/s') },
      { label: 'Closest distance', info: 'Min closest', exploration: fmt(metrics.min_closest_distance, 2, ' m') },
    ] });
  }
  // The first- and second-task measures need point E marked in both phases.
  const missingE = row
    ? [row.learning_split_t_s == null ? 'learning' : null, row.exploration_split_t_s == null ? 'exploration' : null].filter(Boolean) as string[]
    : [];
  const stats = groups.flatMap((g) => g.rows);
  if (!stats.length) return <div className="miniTrialStats miniTrialEmpty">No data available.</div>;
  return (
    <div className="miniTrialStats">
      {/* excluded_from_stats can flip locally (annotation override) before the
       * next bulk refetch reflects it in performance_score_details, which the
       * backend already nulls out for an excluded trial — check both so the
       * line disappears immediately either way. */}
      {/*
      <PerformanceScoreRow
        details={row?.excluded_from_stats ? null : (row?.performance_score_details ?? null)}
        correlations={correlations}
      />
      <NavMetricsRow metrics={row?.excluded_from_stats ? null : (row?.nav_metrics ?? null)} />
      */}
      {missingE.length ? (
        <div className="miniStatGroup task missingE">
          <div className="miniStatGroupTitle">First and second task</div>
          <p>
            Point E is not marked in the {missingE.join(' and the ')} phase of this trial, so the first- and second-task
            measures cannot be computed. Mark it in the trial card in Trial metrics (edit mode); the whole-recording
            values below do not need it.
          </p>
        </div>
      ) : null}
      {groups.filter((group) => !(group.needsE && missingE.length)).map((group) => {
        const hasLearning = group.rows.some((r) => r.learning !== undefined);
        const main = group.rows.filter((r) => !r.secondary);
        const extra = group.rows.filter((r) => r.secondary);
        const measureRow = (r: MeasureRow) => (
          <tr key={r.label}>
            <td>
              {r.label}
              {r.info && STAT_INFO[r.info] ? <InfoPopover>{STAT_INFO[r.info]}</InfoPopover> : null}
            </td>
            <td>{r.exploration}</td>
            {hasLearning ? <td>{r.learning ?? ''}</td> : null}
          </tr>
        );
        return (
          <div key={group.title} className={`miniStatGroup${group.task ? ' task' : ''}`}>
            <div className="miniStatGroupTitle">
              {group.title}
              {group.subtitle ? <small>{group.subtitle}</small> : null}
            </div>
            {group.segments ? (
              <table className="miniSegmentTable">
                <thead><tr><th /><th>Trajectory length</th><th>Duration</th><th>Walking speed</th></tr></thead>
                <tbody>
                  {group.segments.map(([name, lengthM, durationS, speedMS]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{fmt(lengthM, 1, ' m')}</td>
                      <td>{fmt(durationS, 0, ' s')}</td>
                      <td>{fmt(speedMS, 2, ' m/s')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {group.point ? (
              <table className="miniSegmentTable">
                <thead><tr><th /><th>Learning</th><th>Exploration</th><th>Distance</th></tr></thead>
                <tbody>
                  <tr>
                    <td>
                      {group.point.label}
                      {STAT_INFO[group.point.info] ? <InfoPopover>{STAT_INFO[group.point.info]}</InfoPopover> : null}
                    </td>
                    <td>{fmtXY(group.point.learning)}</td>
                    <td>{fmtXY(group.point.exploration)}</td>
                    <td>{fmt(group.point.delta, 2, ' m')}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}
            <table className="miniSegmentTable miniMeasureTable">
              <thead><tr><th>Measure</th><th>Exploration</th>{hasLearning ? <th>Learning</th> : null}</tr></thead>
              <tbody>{main.map(measureRow)}</tbody>
            </table>
            {extra.length ? (
              <details className="miniMoreMeasures">
                <summary>More: {extra.map((r) => r.label.replace(/ \(.*\)$/, '').toLowerCase()).join(', ')}</summary>
                <table className="miniSegmentTable miniMeasureTable">
                  <tbody>{extra.map(measureRow)}</tbody>
                </table>
              </details>
            ) : null}
          </div>
        );
      })}
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

/** Corrects the common data-collection mistake of starting the wrong phase
 * (learning recorded as exploration or vice versa) for the two recordings
 * currently selected in this mini-card. Two separate confirmations, each
 * naming the actual recordings involved, since this reclassifies raw data
 * for every downstream metric on this trial. */
function PhaseSwapButton({
  learningSession, explorationSession, onSwapped,
}: {
  learningSession: SessionRow | undefined;
  explorationSession: SessionRow | undefined;
  /** Applies the swap to just this one trial's labels/metrics — a scoped
   * re-fetch (see handlePhaseSwapped in the parent) instead of the full
   * bulk /api/trials/compare, which would recompute every trial for every
   * patient (30-70s) just to update this one card. */
  onSwapped: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!learningSession || !explorationSession) return null;

  async function handleSwap() {
    const first = window.confirm(
      `Scambiare le fasi di questi due file?\n\n`
      + `Ora "learning": ${timeLabel(learningSession!.start_time)} (${fmt(learningSession!.duration_s, 0, 's')})\n`
      + `Ora "exploration": ${timeLabel(explorationSession!.start_time)} (${fmt(explorationSession!.duration_s, 0, 's')})\n\n`
      + `Dopo lo scambio, il primo diventerà "exploration" e il secondo "learning". `
      + `Il file grezzo originale non viene modificato — solo l'etichetta di fase usata dall'analisi.`
    );
    if (!first) return;
    const second = window.confirm(
      `Confermi di nuovo? Questa modifica cambia come TUTTE le metriche di questo trial vengono calcolate `
      + `(overlap, Fréchet, DTW, found landmarks, ecc.) finché non la annulli di nuovo.`
    );
    if (!second) return;

    setSaving(true);
    setError(null);
    try {
      await swapPhase({ learningFileName: learningSession!.file_name, explorationFileName: explorationSession!.file_name });
      setSaving(false);
      setApplying(true);
      await onSwapped();
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setApplying(false);
    }
  }

  return (
    <span className="miniPhaseSwap">
      <button type="button" className="miniPhaseSwapBtn" onClick={handleSwap} disabled={saving || applying} title="Scambia quale registrazione è 'learning' e quale è 'exploration' per questo trial, e aggiorna subito questa card">
        ⇄ {saving ? 'Saving…' : applying ? 'Updating…' : 'Swap phases'}
      </button>
      {done ? <span className="miniSavingHint">Fatto — questa card è aggiornata.</span> : null}
      {error ? <span className="miniSavingHint miniSavingError">{error}</span> : null}
    </span>
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

/** Tri-state override select shared by the "Found" (per target) and "In
 * order" (per trial) controls below — same Auto-detected/override pattern
 * already used for the lost/not-lost override in TrialAnnotationEditor. */
function TriStateOverrideSelect({
  value, onChange, trueLabel, falseLabel, title, saving,
}: {
  value: boolean | null | undefined;
  onChange: (next: boolean | null) => void;
  trueLabel: string;
  falseLabel: string;
  title: string;
  saving: boolean;
}) {
  return (
    <select
      value={value == null ? 'auto' : value ? 'true' : 'false'}
      title={title}
      disabled={saving}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === 'auto' ? null : v === 'true');
      }}
    >
      <option value="auto">Auto-detected</option>
      <option value="true">{trueLabel}</option>
      <option value="false">{falseLabel}</option>
    </select>
  );
}

/** haptic_on_object_intes never tracked the O1/O2/O3 tags (only the seeker
 * P1), so there's no automatic position to derive "found"/proximity from —
 * this lets the researcher enter each target's real-world coordinate by hand,
 * plus override "found" and trial-level "in order" directly when the
 * automatic feedback/distance-based detection still gets it wrong (e.g. the
 * seeker's path never quite entered the found-radius even though the
 * researcher's own notes/video confirm the object was found).
 * Only rendered for that one condition (MANUAL_COORDS_CONDITION). */
function TargetCoordinateForm({
  patient, condition, pathId, targetIds, coordsByTarget, discovery, onCoordSaved, onDiscoveryChanged,
}: {
  patient: string;
  condition: string;
  pathId: string;
  targetIds: string[];
  coordsByTarget: Record<string, [number, number] | null>;
  discovery: TargetDiscovery | null;
  onCoordSaved: (targetId: string, xy: [number, number] | null) => void;
  onDiscoveryChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, { x: string; y: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingInOrder, setSavingInOrder] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const valueFor = (tid: string, axis: 'x' | 'y'): string => {
    if (drafts[tid]?.[axis] !== undefined) return drafts[tid][axis];
    const xy = coordsByTarget[tid];
    return xy ? String(xy[axis === 'x' ? 0 : 1]) : '';
  };

  async function persistCoord(tid: string) {
    const xStr = valueFor(tid, 'x');
    const yStr = valueFor(tid, 'y');
    const x = Number(xStr);
    const y = Number(yStr);
    // Both fields emptied: remove the saved coordinate, so it does not come back.
    const clearing = xStr === '' && yStr === '';
    if (clearing && !coordsByTarget[tid]) return;
    if (!clearing && (xStr === '' || yStr === '' || !Number.isFinite(x) || !Number.isFinite(y))) return;
    setSavingId(tid);
    setSaveError(null);
    try {
      await saveTargetCoordinate({ patient, condition, pathId, targetId: tid, x: clearing ? null : x, y: clearing ? null : y });
      onCoordSaved(tid, clearing ? null : [x, y]);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  async function persistFound(tid: string, found: boolean | null) {
    setSavingId(tid);
    setSaveError(null);
    try {
      await saveManualTargetFound({ patient, condition, pathId, targetId: tid, found });
      onDiscoveryChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  async function persistInOrder(inOrder: boolean | null) {
    setSavingInOrder(true);
    setSaveError(null);
    try {
      await saveManualInOrder({ patient, condition, pathId, inOrder });
      onDiscoveryChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingInOrder(false);
    }
  }

  const entryByTarget = new Map((discovery?.targets ?? []).map((t) => [t.target_id, t]));

  return (
    <div className="miniCoordForm">
      <div className="miniCoordFormTitle">
        Manual target coordinates
        <InfoPopover>
          <p>No sensor tracked O1/O2/O3 for this condition (only the seeker P1 was tracked) — enter each object's real-world (x, y) position by hand, in meters, using the same room coordinates as the anchors. Shown on the map as a red X.</p>
          <p>"Found" and "In order" default to the automatic feedback/distance-based detection (see the coordinate note above) — override either one directly when you know the real outcome better than the heuristic does (e.g. from notes or video).</p>
        </InfoPopover>
      </div>
      {targetIds.map((tid) => {
        const entry: TargetDiscoveryEntry | undefined = entryByTarget.get(tid);
        return (
          <div key={tid} className="miniCoordRow">
            <span>{tid}</span>
            <input
              type="number" step="0.1" placeholder="x (m)"
              value={valueFor(tid, 'x')}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [tid]: { x: e.target.value, y: valueFor(tid, 'y') } }))}
              onBlur={() => persistCoord(tid)}
            />
            <input
              type="number" step="0.1" placeholder="y (m)"
              value={valueFor(tid, 'y')}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [tid]: { x: valueFor(tid, 'x'), y: e.target.value } }))}
              onBlur={() => persistCoord(tid)}
            />
            <TriStateOverrideSelect
              value={entry?.manual_found_override}
              trueLabel="Found"
              falseLabel="Not found"
              title={`Override whether ${tid} was found — automatic result: ${entry?.found ? 'found' : 'not found'}`}
              saving={savingId === tid}
              onChange={(next) => persistFound(tid, next)}
            />
            {savingId === tid ? <span className="miniSavingHint">Saving…</span> : null}
          </div>
        );
      })}
      <div className="miniCoordRow">
        <span style={{ width: 'auto' }}>In order</span>
        <TriStateOverrideSelect
          value={discovery?.manual_in_order_override}
          trueLabel="In order"
          falseLabel="Out of order"
          title={`Override whether the found landmarks were reached in order — automatic result: ${discovery?.in_order == null ? 'n/a' : discovery.in_order ? 'in order' : 'out of order'}`}
          saving={savingInOrder}
          onChange={(next) => persistInOrder(next)}
        />
        {savingInOrder ? <span className="miniSavingHint">Saving…</span> : null}
      </div>
      {saveError ? <span className="miniSavingHint miniSavingError">{saveError}</span> : null}
    </div>
  );
}

/** One condition×path mini-card: map + status + stats + annotation editor
 * (+ manual coordinate form when applicable). Extracted into its own
 * component (out of the parent's `cells.map(...)`) so it can own its own
 * `hoverK` state for the Deviation profile chart ↔ map point-linking —
 * calling useState inside a .map() callback would break React's hook rules. */
function TrialCard({
  cell, patient, payloads, chosenId, trialRows, discoveryOverrides, setDiscoveryOverrides,
  annotationOverrides, setAnnotationOverrides, coordOverrides, setCoordOverrides,
  showBorder, showAnchors, showGrid, showIdealPath, onSetChoice, onAnnotationSaved, onPhaseSwapped,
  taskSplits, setTaskSplits,
}: {
  cell: Cell;
  patient: string;
  payloads: Map<number, SessionPayload>;
  chosenId: (cell: Cell, cp: CellPhase) => number | null;
  trialRows: TrialRow[];
  discoveryOverrides: Record<string, TrialRow>;
  setDiscoveryOverrides: (fn: (prev: Record<string, TrialRow>) => Record<string, TrialRow>) => void;
  annotationOverrides: Record<string, { manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }>;
  setAnnotationOverrides: (fn: (prev: Record<string, { manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }>) => Record<string, { manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }>) => void;
  coordOverrides: Record<string, [number, number] | null>;
  setCoordOverrides: (fn: (prev: Record<string, [number, number] | null>) => Record<string, [number, number] | null>) => void;
  showBorder: boolean;
  showAnchors: boolean;
  showGrid: boolean;
  showIdealPath: boolean;
  onSetChoice: (condition: string, pathId: string, phase: string, sessionId: number) => void;
  onAnnotationSaved?: (info: { condition: string; pathId: string; explorationSessionId: number | null; excludedFromStats: boolean }) => void;
  onPhaseSwapped: (condition: string, path: string, formerLearningId: number, formerExplorationId: number) => Promise<void>;
  taskSplits: Record<string, TaskSplit>;
  setTaskSplits: (next: Record<string, TaskSplit>) => void;
}) {
  // Index (0..99) hovered on this card's own Deviation profile chart — drives
  // the highlighted point pair on this card's own map, nowhere else.
  const [hoverK, setHoverK] = useState<number | null>(null);
  const editMode = useEditMode();

  const phasePayloads = cell.phases
    .map((cp) => {
      const id = chosenId(cell, cp);
      const payload = id !== null ? payloads.get(id) : undefined;
      return payload ? { phase: cp.phase, payload } : null;
    })
    .filter((p): p is { phase: PhaseName; payload: SessionPayload } => p !== null);
  const anySession = cell.phases.some((cp) => cp.all.length > 0);
  const learningCp = cell.phases.find((cp) => cp.phase === 'learning')!;
  const learningId = chosenId(cell, learningCp);
  const learningSession = learningCp.all.find((s) => s.session_id === learningId);
  const explorationCp = cell.phases.find((cp) => cp.phase === 'exploration')!;
  const explorationId = chosenId(cell, explorationCp);
  const explorationSession = explorationCp.all.find((s) => s.session_id === explorationId);
  const discoveryKey = `${cell.condition}|${cell.path}`;
  const trialRow = discoveryOverrides[discoveryKey] ?? trialRows.find((r) =>
    r.condition === cell.condition && r.path_id === cell.path && r.exploration_session_id === explorationId
  ) ?? null;
  const explorationMetrics = phasePayloads.find((p) => p.phase === 'exploration')?.payload.metrics ?? null;

  // Point E (end of route / start of the walk back), marked per recording.
  const [splitPhasePref, setSplitPhasePref] = useState<PhaseName>('exploration');
  const [splitPicking, setSplitPicking] = useState(false);
  const [splitDraftT, setSplitDraftT] = useState<number | null>(null);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const splitPhases = phasePayloads.map((p) => p.phase);
  const splitPhase: PhaseName = splitPhases.includes(splitPhasePref) ? splitPhasePref : (splitPhases[0] ?? 'exploration');
  const splitSession = splitPhase === 'learning' ? learningSession : explorationSession;
  const splitFileName = splitSession?.file_name ?? null;
  const splitPayload = phasePayloads.find((p) => p.phase === splitPhase)?.payload;
  const splitPoints = useMemo(() => (splitPayload ? seekerPoints(splitPayload) : []), [splitPayload]);
  const splitSavedT = splitFileName ? (taskSplits[splitFileName]?.t_s ?? null) : null;
  useEffect(() => {
    setSplitDraftT(null);
    setSplitPicking(false);
    setSplitError(null);
  }, [splitFileName]);
  const commitSplit = (t: number | null) => {
    if (!splitFileName || !editMode) return;
    const pt = t != null && splitPoints.length ? splitPoints[indexAtTime(splitPoints, t)] : null;
    setSplitSaving(true);
    setSplitError(null);
    saveTaskSplit({ fileName: splitFileName, tS: t != null ? Math.round(t * 10) / 10 : null, x: pt?.posX, y: pt?.posY })
      .then((next) => {
        setTaskSplits(next);
        setSplitDraftT((cur) => (cur === t ? null : cur));
        setSplitPicking(false);
        // The marked point feeds the per-task and route-comparison metrics.
        invalidateDerivedCaches(patient);
        return refetchDiscoveryRow();
      })
      .catch((e) => setSplitError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSplitSaving(false));
  };
  const splitsForMap: Partial<Record<PhaseName, number | null>> = {
    learning: learningSession ? (taskSplits[learningSession.file_name]?.t_s ?? null) : null,
    exploration: explorationSession ? (taskSplits[explorationSession.file_name]?.t_s ?? null) : null,
  };
  if (splitDraftT != null) splitsForMap[splitPhase] = splitDraftT;

  // Re-fetch just this one (patient, condition, path) instead of the full
  // bulk /api/trials/compare (30-70s) — used after any manual coordinate,
  // found, or in-order save so this card's own found/order/map updates
  // immediately, without disturbing every other card on the grid.
  function refetchDiscoveryRow() {
    return fetchTrialRows({ patients: [patient], condition: cell.condition, pathId: cell.path, includeSuspicious: true })
      .then((rows) => {
        const fresh = rows.find((r) => r.exploration_session_id === explorationId) ?? rows[0] ?? null;
        if (fresh) setDiscoveryOverrides((prev) => ({ ...prev, [discoveryKey]: fresh }));
      })
      .catch(() => {});
  }

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

  // haptic_on_object_intes never tracked O1/O2/O3, only the seeker —
  // target ids still come through target_discovery (config order),
  // just always unfound until a coordinate is entered by hand.
  const isManualCoordsCell = cell.condition === MANUAL_COORDS_CONDITION;
  const cellTargetIds = trialRow?.target_discovery?.targets.map((t) => t.target_id) ?? ['O1', 'O2', 'O3'];
  const coordsByTarget: Record<string, [number, number] | null> = {};
  for (const tid of cellTargetIds) {
    const overrideKey = `${cell.condition}|${cell.path}|${tid}`;
    const fromRow = trialRow?.target_discovery?.targets.find((t) => t.target_id === tid)?.manual_xy ?? null;
    coordsByTarget[tid] = overrideKey in coordOverrides ? coordOverrides[overrideKey] : fromRow;
  }
  const manualTargetsForCell = isManualCoordsCell
    ? cellTargetIds
        .filter((tid) => coordsByTarget[tid])
        .map((tid) => ({ target_id: tid, x: coordsByTarget[tid]![0], y: coordsByTarget[tid]![1] }))
    : [];

  // The target waypoints in visit order (O1 -> O2 -> O3, from `turns`,
  // already ordered by turn_index) — start/stop left out for now (no
  // trustworthy coordinates yet; add them once available).
  const idealPathPoints: [number, number][] | null = effectiveRow?.turns?.length
    ? [...effectiveRow.turns].sort((a, b) => a.turn_index - b.turn_index).map((t): [number, number] => [t.x, t.y])
    : null;

  return (
    <div className={`miniTrajCard ${conditionCardClass(cell.condition)}`}>
      <div className="miniTrajTitle">
        <strong>{cell.label}</strong>
        <span>path {routeLabel(cell.path, trialRow?.route_id ?? cell.phases.flatMap((cp) => cp.all)[0]?.route_id)}</span>
      </div>
      {anySession ? (
        <>
          <MiniTrajectory
            payloads={phasePayloads}
            showBorder={showBorder}
            showAnchors={showAnchors}
            showGrid={showGrid}
            manualTargets={manualTargetsForCell}
            suppressTrackedTargetIds={isManualCoordsCell ? cellTargetIds : undefined}
            idealPath={showIdealPath ? idealPathPoints : null}
            learnResampledXY={effectiveRow?.learn_resampled_xy}
            expResampledXY={effectiveRow?.exp_resampled_xy}
            hoverIndex={hoverK}
            splits={splitsForMap}
            pickPhase={splitPicking ? splitPhase : null}
            onPick={(pt) => commitSplit(pt.t)}
          />
          <fieldset className="editGate" disabled={!editMode} title={editMode ? undefined : "Read only: turn on edit mode to change point E"}>
          <TaskSplitEditor
            phases={splitPhases}
            phase={splitPhase}
            onPhase={setSplitPhasePref}
            points={splitPoints}
            savedT={splitSavedT}
            draftT={splitDraftT}
            onDraftT={setSplitDraftT}
            picking={splitPicking}
            onPicking={setSplitPicking}
            onCommit={commitSplit}
            saving={splitSaving}
            error={splitError}
            marks={{
              learning: learningSession ? (taskSplits[learningSession.file_name]?.t_s ?? null) : null,
              exploration: explorationSession ? (taskSplits[explorationSession.file_name]?.t_s ?? null) : null,
            }}
          />
          </fieldset>
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
                          onChange={(e) => onSetChoice(cell.condition, cell.path, cp.phase, Number(e.target.value))}
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
            <fieldset className="editGate" disabled={!editMode}>
              <PhaseSwapButton
                learningSession={learningSession}
                explorationSession={explorationSession}
                onSwapped={() => onPhaseSwapped(cell.condition, cell.path, learningSession!.session_id, explorationSession!.session_id)}
              />
            </fieldset>
          </div>
          <TrialMiniStats row={effectiveRow} metrics={explorationMetrics} onHoverDeviationIndex={setHoverK} />
          <fieldset className="editGate" disabled={!editMode}>
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
          </fieldset>
          {isManualCoordsCell ? (
            <fieldset className="editGate" disabled={!editMode}>
            <TargetCoordinateForm
              patient={patient}
              condition={cell.condition}
              pathId={cell.path}
              targetIds={cellTargetIds}
              coordsByTarget={coordsByTarget}
              discovery={trialRow?.target_discovery ?? null}
              onCoordSaved={(tid, xy) => {
                setCoordOverrides((prev) => ({ ...prev, [`${cell.condition}|${cell.path}|${tid}`]: xy }));
                refetchDiscoveryRow();
              }}
              onDiscoveryChanged={refetchDiscoveryRow}
            />
            </fieldset>
          ) : null}
        </>
      ) : (
        <div className="miniTrajEmpty">No session recorded for this condition/route.</div>
      )}
    </div>
  );
}

export function ConditionTrajectoriesGrid({
  sessions, patient, trialRows, bare = false, onAnnotationSaved,
  showBorder, onShowBorder, showAnchors, onShowAnchors, showGrid, onShowGrid,
  showIdealPath, onShowIdealPath,
  alpha, onAlpha, smoothTrajectory, onSmoothTrajectory, smoothOnlySeeker, onSmoothOnlySeeker,
  choices, onSetChoice,
}: Props) {
  const [payloads, setPayloads] = useState<Map<number, SessionPayload>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [annotationOverrides, setAnnotationOverrides] = useState<Record<string, { manual_lost: boolean | null; comment: string; excluded_from_stats: boolean }>>({});
  // Manually-entered target coordinates, keyed `${condition}|${path}|${target_id}`
  // — shown immediately (red marker) after saving, without waiting for a
  // full trialRows refetch to see the new found/order recomputation.
  const [coordOverrides, setCoordOverrides] = useState<Record<string, [number, number] | null>>({});
  // Freshly-recomputed trial row (found/order/etc, now reflecting the just-saved
  // coordinate) fetched with a small scoped request right after saving — the
  // full bulk /api/trials/compare fetch is too slow (30-70s) to redo per-edit.
  const [discoveryOverrides, setDiscoveryOverrides] = useState<Record<string, TrialRow>>({});
  // Instant local flip of a session's learning/exploration label right after
  // "Scambia fasi" — the raw file's phase field on disk is unchanged (the
  // swap only writes a small override on the backend), so no need to wait
  // for a full sessions refetch to see the two recordings' labels swap here.
  const [sessionPhaseOverrides, setSessionPhaseOverrides] = useState<Record<number, PhaseName>>({});
  // Manually marked point E per recording, keyed by file_name.
  const [taskSplits, setTaskSplits] = useState<Record<string, TaskSplit>>({});
  useEffect(() => {
    let cancelled = false;
    fetchTaskSplits().then((s) => { if (!cancelled) setTaskSplits(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // After "Scambia fasi": flip the two recordings' labels immediately (no
  // network round-trip needed, see sessionPhaseOverrides above), then clear
  // the backend's cache (required for it to pick up the new phase override —
  // otherwise it keeps returning the pre-swap metrics) and re-fetch metrics
  // for ONLY this one (condition, path) instead of the full bulk
  // /api/trials/compare, which recomputes every trial for every patient and
  // can take 30-70s.
  const handlePhaseSwapped = async (
    condition: string, path: string, formerLearningId: number, formerExplorationId: number,
  ) => {
    setSessionPhaseOverrides((prev) => ({
      ...prev, [formerLearningId]: 'exploration', [formerExplorationId]: 'learning',
    }));
    await refreshIndex();
    const rows = await fetchTrialRows({ patients: [patient], condition, pathId: path, includeSuspicious: true });
    const fresh = rows.find((r) => r.exploration_session_id === formerLearningId) ?? rows[0] ?? null;
    if (fresh) setDiscoveryOverrides((prev) => ({ ...prev, [`${condition}|${path}`]: fresh }));
    // refreshIndex() already reset the ANOVA/correlations caches, but with no
    // specific patient — General statistics' own bulk trial-row cache for
    // THIS patient still needs an explicit nudge (see the App-level
    // onDerivedCachesInvalidated subscription).
    invalidateDerivedCaches(patient);
  };

  // Smoothing settings changing should drop the stale cache — but every
  // effect also fires once on mount, and setting a *new* empty Map there
  // (even though the state already starts empty) still bumps `payloads` by
  // reference. Since neededIds depends on `choices` and the fetch effect
  // depends on `neededIds`/`payloads`, that phantom mount-time reset was
  // enough to abort and restart the entire first fetch batch for no reason.
  // Skip each effect's own first run.
  const payloadsMounted = useRef(false);
  useEffect(() => {
    if (!payloadsMounted.current) { payloadsMounted.current = true; return; }
    setPayloads(new Map());
  }, [alpha, smoothTrajectory, smoothOnlySeeker]);
  const choicesMounted = useRef(false);
  useEffect(() => {
    if (!choicesMounted.current) { choicesMounted.current = true; return; }
    setAnnotationOverrides({});
  }, [patient]);

  // condition → paths from the current patient's recordings (any status):
  // path assignment varies per patient, so the grid is 4 conditions × the
  // 2 paths this patient actually ran = 8 charts. A cell whose recordings
  // are all invalid still shows up, as an explicitly empty chart.
  const cells = useMemo<Cell[]>(() => {
    const effectivePhase = (s: SessionRow): string => sessionPhaseOverrides[s.session_id] ?? s.phase;
    const conditionMap = new Map<string, { label: string; paths: Set<string> }>();
    for (const s of sessions) {
      if (s.patient !== patient || !s.condition || !s.path_id) continue;
      const entry = conditionMap.get(s.condition) ?? { label: conditionLabel(s.condition), paths: new Set<string>() };
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
              .filter((s) => s.patient === patient && s.condition === condition && s.path_id === path && effectivePhase(s) === phase)
              .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))),
          })),
        });
      }
    }
    return out;
  }, [sessions, patient, sessionPhaseOverrides]);

  // Default to the most recent recording per phase (valid or not — inspecting
  // a disrupted attempt is often exactly the point in this tab).
  const chosenId = (cell: Cell, cp: CellPhase): number | null => {
    if (!cp.all.length) return null;
    const key = `${cell.condition}|${cell.path}|${cp.phase}`;
    const chosen = choices[key];
    if (chosen !== undefined && cp.all.some((s) => s.session_id === chosen)) return chosen;
    // A recording fixed by hand on the backend (recording_pins.json) is the default instead of the latest.
    const pinnedRow = trialRows.find((r) => r.condition === cell.condition && r.path_id === cell.path
      && (cp.phase === 'exploration' ? r.exploration_pinned : r.learning_pinned));
    const pinnedId = cp.phase === 'exploration' ? pinnedRow?.exploration_session_id : pinnedRow?.learning_session_id;
    if (pinnedId != null && cp.all.some((s) => s.session_id === pinnedId)) return pinnedId;
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
  }, [cells, choices, trialRows]);

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
        <label className="inlineCheck" title="Percorso ideale a linee rette (start → O1 → O2 → O3 → stop) — il riferimento usato per il calcolo di Route efficiency.">
          <input type="checkbox" checked={showIdealPath} onChange={(e) => onShowIdealPath(e.target.checked)} />
          Ideal path
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
          {cells.map((cell) => (
            <TrialCard
              key={`${cell.condition}-${cell.path}`}
              cell={cell}
              patient={patient}
              payloads={payloads}
              chosenId={chosenId}
              trialRows={trialRows}
              discoveryOverrides={discoveryOverrides}
              setDiscoveryOverrides={setDiscoveryOverrides}
              annotationOverrides={annotationOverrides}
              setAnnotationOverrides={setAnnotationOverrides}
              coordOverrides={coordOverrides}
              setCoordOverrides={setCoordOverrides}
              showBorder={showBorder}
              showAnchors={showAnchors}
              showGrid={showGrid}
              showIdealPath={showIdealPath}
              onSetChoice={onSetChoice}
              onAnnotationSaved={onAnnotationSaved}
              onPhaseSwapped={handlePhaseSwapped}
              taskSplits={taskSplits}
              setTaskSplits={setTaskSplits}
            />
          ))}
      </div>
    </div>
  );

  if (bare) return gridBody;

  return (
    <section className="card span2 conditionGridCard">
      <div className="cardHeader">
        <div>
          <strong>Learning vs exploration — all trials ({patient})</strong>
          <small>{cells.length} charts: one per condition × route, with the aggregated trial metrics for the selected attempt.</small>
        </div>
        {loading ? <RefreshCw size={15} className="spin" /> : null}
      </div>
      {gridBody}
    </section>
  );
}
