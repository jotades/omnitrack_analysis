import { useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SessionPayload, TrackingPoint } from '../types';
import { ChartCard } from './ChartCard';
import { ChartFrame } from './ChartFrame';

const palette = ['#3b5bfd', '#17b26a', '#f79009', '#7a5af8', '#06aed4', '#d92d20', '#667085'];
const phasePalette: Record<string, string> = {
  learning: '#3b5bfd',
  exploration: '#f79009',
};

type RoomPreset = '8x12' | '12x8';
type OverlayMode = 'off' | 'learningExploration';

interface Trajectory2DProps {
  payload: SessionPayload;
  showCookedOverlay: boolean;
  playbackTime?: number | null;
  duration?: number;
  onCursorTime?: (time: number) => void;
  phaseOverlayPayloads?: SessionPayload[];
  showPhaseOverlay?: boolean;
  onShowPhaseOverlay?: (enabled: boolean) => void;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampTime(value: number | null | undefined, duration: number) {
  if (!isFiniteNumber(value)) return duration;
  return Math.max(0, Math.min(duration, value));
}

function roomDims(roomPreset: RoomPreset) {
  return roomPreset === '8x12' ? { roomX: 8, roomY: 12 } : { roomX: 12, roomY: 8 };
}

function transformPoint(x: number, y: number, roomX: number, roomY: number, rotate90: boolean) {
  if (!rotate90) {
    return { x2d: x, y2d: y, displayRoomX: roomX, displayRoomY: roomY, xLabel: 'x', yLabel: 'y' };
  }

  // 90° counter-clockwise rotation: an 8x12 room becomes 12x8 while keeping physical proportions.
  return {
    x2d: y,
    y2d: roomX - x,
    displayRoomX: roomY,
    displayRoomY: roomX,
    xLabel: 'original y',
    yLabel: 'original x rotated',
  };
}

function enrichPoint(p: TrackingPoint, usePlot: boolean, roomX: number, roomY: number, rotate90: boolean) {
  const x = usePlot ? p.x_plot : p.x;
  const y = usePlot ? p.y_plot : p.y;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(p.t_s) || !p.tag_id) return null;
  const transformed = transformPoint(x, y, roomX, roomY, rotate90);
  return {
    ...p,
    xRaw2d: x,
    yRaw2d: y,
    x2d: transformed.x2d,
    y2d: transformed.y2d,
    time: `${p.t_s.toFixed(2)} s`,
  };
}

function byTag(points: TrackingPoint[], usePlot: boolean, untilTime: number | null | undefined, roomX: number, roomY: number, rotate90: boolean) {
  const map = new Map<string, Array<Record<string, any>>>();
  for (const p of points) {
    if (isFiniteNumber(untilTime) && isFiniteNumber(p.t_s) && p.t_s > untilTime) continue;
    const enriched = enrichPoint(p, usePlot, roomX, roomY, rotate90);
    if (!enriched) continue;
    const arr = map.get(p.tag_id) ?? [];
    arr.push(enriched);
    map.set(p.tag_id, arr);
  }
  return Array.from(map.entries()).map(([tag, data]) => ({ tag, data: data.sort((a, b) => a.t_s - b.t_s) }));
}

function pointsForTag(points: TrackingPoint[], tagId: string, untilTime: number | null | undefined, usePlot: boolean, roomX: number, roomY: number, rotate90: boolean) {
  return byTag(points.filter((p) => p.tag_id === tagId), usePlot, untilTime, roomX, roomY, rotate90)[0]?.data ?? [];
}

function fullStartEnd(points: TrackingPoint[], tagId: string, usePlot: boolean, roomX: number, roomY: number, rotate90: boolean) {
  const data = pointsForTag(points, tagId, undefined, usePlot, roomX, roomY, rotate90);
  return { start: data[0], end: data[data.length - 1] };
}

function CustomLegend({ items }: { items: Array<{ name: string; color: string; dashed?: boolean }> }) {
  if (!items.length) return null;
  return (
    <div className="customLegend">
      {items.map((item) => (
        <span key={item.name}>
          <i style={{ background: item.color, borderRadius: item.dashed ? 0 : undefined }} />
          {item.name}
        </span>
      ))}
    </div>
  );
}

function TrajectoryTooltip({ active, payload }: any) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="chartTooltip">
      <strong>{p.tag_id ?? p.tag ?? p.phase ?? 'point'}</strong>
      <span>t = {isFiniteNumber(p.t_s) ? p.t_s.toFixed(2) : '—'} s</span>
      <span>original x = {isFiniteNumber(p.xRaw2d) ? p.xRaw2d.toFixed(3) : '—'} m</span>
      <span>original y = {isFiniteNumber(p.yRaw2d) ? p.yRaw2d.toFixed(3) : '—'} m</span>
    </div>
  );
}

/**
 * Walking direction at a trajectory point: IMU yaw corrected by the mounting
 * offset when available, otherwise the tangent of the recent trajectory.
 * Returns a display-space angle (adjusted for the rotated room view).
 */
function headingFor(
  now: Record<string, any> | undefined,
  recent: Array<Record<string, any>>,
  offsetDeg: number,
  rotate90: boolean,
): number | null {
  if (!now) return null;
  let theta: number | null = null;
  if (isFiniteNumber(now.yaw_deg)) {
    theta = now.yaw_deg - offsetDeg;
  } else if (recent.length >= 2) {
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dx = b.xRaw2d - a.xRaw2d;
    const dy = b.yRaw2d - a.yRaw2d;
    if (Math.hypot(dx, dy) > 0.05) theta = (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  if (theta === null) return null;
  // The rotated view maps (x, y) → (y, roomX − x), which subtracts 90° from any heading.
  return rotate90 ? theta - 90 : theta;
}

/**
 * Walking-direction arrow rendered at the current seeker position.
 * `angleDeg` is a math angle in data space (0° = +x, CCW positive);
 * SVG y grows downwards, so the rotation is negated.
 */
function directionArrowShape(angleDeg: number, color: string) {
  return function ArrowShape(props: any) {
    const { cx, cy } = props;
    if (!isFiniteNumber(cx) || !isFiniteNumber(cy)) return <g />;
    const len = 34;
    return (
      <g transform={`translate(${cx} ${cy}) rotate(${-angleDeg})`} pointerEvents="none">
        <line x1={10} y1={0} x2={len} y2={0} stroke={color} strokeWidth={3.5} strokeLinecap="round" />
        <polygon points={`${len + 9},0 ${len - 3},-6.5 ${len - 3},6.5`} fill={color} />
      </g>
    );
  };
}

export function Trajectory2D({
  payload,
  showCookedOverlay,
  playbackTime,
  duration,
  onCursorTime,
  phaseOverlayPayloads = [],
  showPhaseOverlay = false,
  onShowPhaseOverlay,
}: Trajectory2DProps) {
  const [roomPreset, setRoomPreset] = useState<RoomPreset>('8x12');
  const [showAllTags, setShowAllTags] = useState(true);
  const [rotate90, setRotate90] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showDirectionArrow, setShowDirectionArrow] = useState(true);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>(showPhaseOverlay ? 'learningExploration' : 'off');
  const hoverAreaRef = useRef<HTMLDivElement | null>(null);
  const preHoverTimeRef = useRef<number | null>(null);

  const { roomX, roomY } = roomDims(roomPreset);
  const displayDims = transformPoint(0, 0, roomX, roomY, rotate90);
  const displayRoomX = displayDims.displayRoomX;
  const displayRoomY = displayDims.displayRoomY;
  const roomAspect = displayRoomX / displayRoomY;
  const computedDuration = duration ?? payload.metrics.duration_s ?? Math.max(0, ...payload.tracking.map((p) => p.t_s).filter(isFiniteNumber));
  const t = clampTime(playbackTime, computedDuration);
  const seeker = payload.config.seeker_id;

  const trackingForCurrentMode = useMemo(() => {
    return showAllTags ? payload.tracking : payload.tracking.filter((p) => p.tag_id === seeker);
  }, [payload.tracking, seeker, showAllTags]);

  const groupedPlot = useMemo(() => byTag(trackingForCurrentMode, true, t, roomX, roomY, rotate90), [trackingForCurrentMode, t, roomX, roomY, rotate90]);
  const cooked = useMemo(() => {
    return showCookedOverlay ? byTag(payload.tracking.filter((p) => p.tag_id === seeker), false, t, roomX, roomY, rotate90) : [];
  }, [payload.tracking, seeker, showCookedOverlay, t, roomX, roomY, rotate90]);

  const seekerVisible = pointsForTag(payload.tracking, seeker, t, true, roomX, roomY, rotate90);
  const seekerNow = seekerVisible[seekerVisible.length - 1];
  const seekerStartEnd = fullStartEnd(payload.tracking, seeker, true, roomX, roomY, rotate90);
  const seekerFull = useMemo(
    () => pointsForTag(payload.tracking, seeker, undefined, true, roomX, roomY, rotate90),
    [payload.tracking, seeker, roomX, roomY, rotate90],
  );

  // Walking direction: IMU yaw corrected by the mounting offset estimated on the
  // backend; falls back to the recent trajectory direction when yaw is missing.
  const arrowAngle = useMemo(() => {
    if (!showDirectionArrow) return null;
    const offset = isFiniteNumber(payload.orientation?.median_offset_deg) ? payload.orientation!.median_offset_deg! : 0;
    return headingFor(seekerNow, seekerVisible.slice(-6), offset, rotate90);
  }, [showDirectionArrow, seekerNow, seekerVisible, payload.orientation, rotate90]);

  /**
   * CompareTwoLines-style interaction: moving the mouse anywhere over the room
   * scrubs the global cursor to the closest point of the seeker path, without
   * having to hit a marker. Leaving the chart restores the pre-hover time.
   */
  const handlePlotHover = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onCursorTime || !seekerFull.length) return;
    const wrapper = hoverAreaRef.current;
    const svg = wrapper?.querySelector('svg');
    const grid = svg?.querySelector('.recharts-cartesian-grid') as SVGGraphicsElement | null;
    if (!svg || !grid) return;

    const svgRect = svg.getBoundingClientRect();
    const plot = grid.getBBox();
    if (!plot.width || !plot.height) return;

    const px = event.clientX - svgRect.left;
    const py = event.clientY - svgRect.top;
    if (px < plot.x || px > plot.x + plot.width || py < plot.y || py > plot.y + plot.height) return;

    const dataX = ((px - plot.x) / plot.width) * displayRoomX;
    const dataY = (1 - (py - plot.y) / plot.height) * displayRoomY;

    let best: { t_s: number; d2: number } | null = null;
    for (const p of seekerFull) {
      const dx = p.x2d - dataX;
      const dy = p.y2d - dataY;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 < best.d2) best = { t_s: p.t_s, d2 };
    }
    // Ignore hovers far away from the path so the cursor doesn't jump wildly.
    if (best && best.d2 <= 1.2 * 1.2) onCursorTime(best.t_s);
  };

  const handlePlotEnter = () => {
    preHoverTimeRef.current = isFiniteNumber(playbackTime) ? playbackTime : null;
  };

  const handlePlotLeave = () => {
    if (onCursorTime && preHoverTimeRef.current !== null) onCursorTime(preHoverTimeRef.current);
    preHoverTimeRef.current = null;
  };

  const overlayEnabled = overlayMode === 'learningExploration' && showPhaseOverlay;
  const phaseOverlays = useMemo(() => {
    if (!overlayEnabled) return [];
    return phaseOverlayPayloads
      .map((phasePayload) => {
        const phase = String(phasePayload.summary?.phase ?? phasePayload.summary?.task ?? 'phase');
        const phaseSeeker = phasePayload.config.seeker_id ?? seeker;
        const data = pointsForTag(phasePayload.tracking, phaseSeeker, t, true, roomX, roomY, rotate90).map((p) => ({ ...p, phase }));
        const endpoints = fullStartEnd(phasePayload.tracking, phaseSeeker, true, roomX, roomY, rotate90);
        // Direction arrow at this phase's current position; skip when the overlay
        // is the selected session itself (the main red arrow already covers it).
        const isCurrentSession = phasePayload.summary?.file === payload.summary?.file;
        const now: Record<string, any> | undefined = data[data.length - 1];
        const offset = isFiniteNumber(phasePayload.orientation?.median_offset_deg) ? phasePayload.orientation!.median_offset_deg! : 0;
        const arrowAngle = isCurrentSession ? null : headingFor(now, data.slice(-6), offset, rotate90);
        return { phase, data, endpoints, now, arrowAngle, color: phasePalette[phase] ?? '#344054' };
      })
      .filter((item) => item.data.length);
  }, [phaseOverlayPayloads, seeker, overlayEnabled, t, roomX, roomY, rotate90, payload.summary]);

  const startEndDots = groupedPlot.flatMap(({ tag, data }) => {
    const start = data[0];
    const end = data[data.length - 1];
    return [
      start ? { ...start, tag, label: `${tag} start`, kind: 'start' } : null,
      end ? { ...end, tag, label: `${tag} now`, kind: 'now' } : null,
    ].filter(Boolean) as Array<Record<string, any>>;
  });

  const legendItems = [
    ...(seekerFull.length ? [{ name: `${seeker} full path (hover to scrub)`, color: '#98a2b3', dashed: true }] : []),
    ...groupedPlot.map(({ tag }, idx) => ({ name: tag, color: palette[idx % palette.length] })),
    ...(cooked.length ? [{ name: `${seeker} cooked α=0.4`, color: '#777' }] : []),
    ...phaseOverlays.map((item) => ({ name: `${item.phase} ${seeker}`, color: item.color, dashed: true })),
  ];

  const pointsOutOfRoom = payload.tracking.filter((p) => {
    const x = p.x_plot ?? p.x;
    const y = p.y_plot ?? p.y;
    return isFiniteNumber(x) && isFiniteNumber(y) && (x < 0 || x > roomX || y < 0 || y > roomY);
  }).length;

  // Alternate label positions so START / END / NOW don't sit on top of the points.
  const labelFor = (text: string, position: 'top' | 'bottom' | 'left' | 'right') =>
    showLabels ? { value: text, position, offset: 12, fill: 'var(--ink)', fontSize: 11, fontWeight: 700 } : undefined;

  return (
    <ChartCard
      title="2D room trajectory"
      subtitle={`Proportional room ${roomX} m × ${roomY} m, ${rotate90 ? 'rotated 90°' : 'original'} view. Move the mouse along the path to scrub every chart, no Play needed.`}
      className="span2"
    >
      {!groupedPlot.length ? (
        <div className="emptyState chartEmpty">No valid 2D points for this session.</div>
      ) : (
        <>
          <div className="chartTools trajectoryTools compactTools">
            <label>
              Trajectory overlay
              <select
                value={overlayMode}
                onChange={(e) => {
                  const next = e.target.value as OverlayMode;
                  setOverlayMode(next);
                  onShowPhaseOverlay?.(next === 'learningExploration');
                }}
              >
                <option value="off">selected session</option>
                <option value="learningExploration">learning + exploration, same patient/path</option>
              </select>
            </label>
            <label>
              Room
              <select value={roomPreset} onChange={(e) => setRoomPreset(e.target.value as RoomPreset)}>
                <option value="8x12">8 m × 12 m</option>
                <option value="12x8">12 m × 8 m</option>
              </select>
            </label>
            <label>
              Orientation
              <select value={rotate90 ? 'rotated' : 'original'} onChange={(e) => setRotate90(e.target.value === 'rotated')}>
                <option value="rotated">rotated 90°</option>
                <option value="original">original</option>
              </select>
            </label>
            <label className="inlineCheck">
              <input type="checkbox" checked={showAllTags} onChange={(e) => setShowAllTags(e.target.checked)} />
              P1 + targets
            </label>
            <label className="inlineCheck">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              Labels
            </label>
            <label className="inlineCheck">
              <input type="checkbox" checked={showDirectionArrow} onChange={(e) => setShowDirectionArrow(e.target.checked)} />
              Direction arrow
            </label>
            <span className="timeBadge">t = {t.toFixed(2)} s / {computedDuration.toFixed(2)} s</span>
            {pointsOutOfRoom ? <span className="warningBadge">{pointsOutOfRoom} points outside room</span> : null}
          </div>

          <ChartFrame aspectRatio={roomAspect} minHeight={360} maxHeight={720} className="roomChartFrame">
            {(width, height) => (
              <div
                ref={hoverAreaRef}
                onMouseMove={handlePlotHover}
                onMouseEnter={handlePlotEnter}
                onMouseLeave={handlePlotLeave}
              >
                <ScatterChart
                  width={width}
                  height={height}
                  margin={{ top: 18, right: 26, bottom: 36, left: 12 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="x2d"
                    name={rotate90 ? 'original y' : 'x'}
                    unit=" m"
                    domain={[0, displayRoomX]}
                    ticks={Array.from({ length: Math.floor(displayRoomX) + 1 }, (_, i) => i)}
                    allowDataOverflow
                  />
                  <YAxis
                    type="number"
                    dataKey="y2d"
                    name={rotate90 ? 'original x rotated' : 'y'}
                    unit=" m"
                    domain={[0, displayRoomY]}
                    ticks={Array.from({ length: Math.floor(displayRoomY) + 1 }, (_, i) => i)}
                    allowDataOverflow
                  />
                  <Tooltip animationDuration={0} isAnimationActive={false} cursor={{ strokeDasharray: '3 3' }} content={<TrajectoryTooltip />} />

                  <ReferenceLine x={0} stroke="var(--ink)" strokeWidth={1.4} />
                  <ReferenceLine x={displayRoomX} stroke="var(--ink)" strokeWidth={1.4} />
                  <ReferenceLine y={0} stroke="var(--ink)" strokeWidth={1.4} />
                  <ReferenceLine y={displayRoomY} stroke="var(--ink)" strokeWidth={1.4} />

                  {seekerFull.length ? (
                    <Scatter
                      name={`${seeker} full path`}
                      data={seekerFull}
                      line={{ stroke: '#98a2b3', strokeOpacity: 0.35, strokeWidth: 1.5, strokeDasharray: '4 3' }}
                      lineType="joint"
                      fill="#98a2b3"
                      fillOpacity={0.25}
                      isAnimationActive={false}
                    />
                  ) : null}

                  {cooked.map(({ tag, data }) => (
                    <Scatter
                      key={`${tag}-cooked`}
                      name={`${tag} cooked α=0.4`}
                      data={data}
                      line={{ stroke: '#777', strokeOpacity: 0.35, strokeWidth: 2 }}
                      lineType="joint"
                      fill="#777"
                      fillOpacity={0.08}
                      isAnimationActive={false}
                    />
                  ))}

                  {groupedPlot.map(({ tag, data }, idx) => {
                    const color = palette[idx % palette.length];
                    return (
                      <Scatter
                        key={tag}
                        name={tag}
                        data={data}
                        line={{ stroke: color, strokeWidth: tag === seeker ? 2.6 : 1.8 }}
                        lineType="joint"
                        fill={color}
                        fillOpacity={tag === seeker ? 0.7 : 0.45}
                        isAnimationActive={false}
                      />
                    );
                  })}

                  {phaseOverlays.map((item) => (
                    <Scatter
                      key={`overlay-${item.phase}`}
                      name={`${item.phase} ${seeker}`}
                      data={item.data}
                      line={{ stroke: item.color, strokeWidth: 3.2, strokeDasharray: item.phase === 'learning' ? '0' : '7 4' }}
                      lineType="joint"
                      fill={item.color}
                      fillOpacity={0.12}
                      isAnimationActive={false}
                    />
                  ))}

                  {seekerStartEnd.start ? (
                    <ReferenceDot x={seekerStartEnd.start.x2d} y={seekerStartEnd.start.y2d} r={7} label={labelFor('START', 'top')} stroke="var(--ink)" fill="var(--surface)" ifOverflow="visible" />
                  ) : null}
                  {seekerStartEnd.end ? (
                    <ReferenceDot x={seekerStartEnd.end.x2d} y={seekerStartEnd.end.y2d} r={7} label={labelFor('END', 'bottom')} stroke="var(--ink)" fill="var(--ink)" ifOverflow="visible" />
                  ) : null}
                  {seekerNow ? (
                    <ReferenceDot x={seekerNow.x2d} y={seekerNow.y2d} r={8} label={labelFor('NOW', rotate90 ? 'top' : 'right')} stroke="var(--surface)" fill="#d92d20" ifOverflow="visible" />
                  ) : null}
                  {seekerNow && arrowAngle !== null ? (
                    <ReferenceDot
                      x={seekerNow.x2d}
                      y={seekerNow.y2d}
                      r={1}
                      shape={directionArrowShape(arrowAngle, '#d92d20')}
                      ifOverflow="visible"
                    />
                  ) : null}
                  {showDirectionArrow ? phaseOverlays.map((item) => (
                    item.now && item.arrowAngle !== null ? (
                      <ReferenceDot
                        key={`${item.phase}-arrow`}
                        x={item.now.x2d}
                        y={item.now.y2d}
                        r={1}
                        shape={directionArrowShape(item.arrowAngle, item.color)}
                        ifOverflow="visible"
                      />
                    ) : null
                  )) : null}

                  {phaseOverlays.flatMap((item) => {
                    const start = item.endpoints.start;
                    const end = item.endpoints.end;
                    return [
                      start ? <ReferenceDot key={`${item.phase}-start`} x={start.x2d} y={start.y2d} r={5} label={labelFor(`${item.phase} start`, 'top')} stroke={item.color} fill="var(--surface)" ifOverflow="visible" /> : null,
                      end ? <ReferenceDot key={`${item.phase}-end`} x={end.x2d} y={end.y2d} r={5} label={labelFor(`${item.phase} end`, 'bottom')} stroke={item.color} fill={item.color} ifOverflow="visible" /> : null,
                    ];
                  })}

                  {startEndDots.filter((dot) => dot.tag !== seeker).map((dot, idx) => (
                    <ReferenceDot
                      key={`${dot.tag}-${dot.kind}`}
                      x={dot.x2d}
                      y={dot.y2d}
                      r={dot.kind === 'start' ? 4 : 5}
                      label={labelFor(dot.label, idx % 2 === 0 ? 'top' : 'bottom')}
                      stroke="var(--muted)"
                      fill={dot.kind === 'start' ? 'var(--surface)' : 'var(--muted)'}
                      ifOverflow="visible"
                    />
                  ))}
                </ScatterChart>
              </div>
            )}
          </ChartFrame>
          <CustomLegend items={legendItems} />
          {overlayMode === 'learningExploration' && !phaseOverlays.length ? (
            <div className="miniWarning">Overlay requested: looking for learning/exploration sessions with the same patient, condition and path. If nothing shows up, one of the two sessions is missing or has no valid P1 points.</div>
          ) : null}
        </>
      )}
    </ChartCard>
  );
}
