import { useMemo, useState } from 'react';
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

  // Rotazione antioraria di 90°: la stanza 8x12 diventa 12x8, mantenendo le proporzioni fisiche.
  return {
    x2d: y,
    y2d: roomX - x,
    displayRoomX: roomY,
    displayRoomY: roomX,
    xLabel: 'y originale',
    yLabel: 'x originale ruotata',
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
      <span>x originale = {isFiniteNumber(p.xRaw2d) ? p.xRaw2d.toFixed(3) : '—'} m</span>
      <span>y originale = {isFiniteNumber(p.yRaw2d) ? p.yRaw2d.toFixed(3) : '—'} m</span>
    </div>
  );
}

export function Trajectory2D({
  payload,
  showCookedOverlay,
  playbackTime,
  duration,
  phaseOverlayPayloads = [],
  showPhaseOverlay = false,
  onShowPhaseOverlay,
}: Trajectory2DProps) {
  const [roomPreset, setRoomPreset] = useState<RoomPreset>('8x12');
  const [showAllTags, setShowAllTags] = useState(true);
  const [rotate90, setRotate90] = useState(true);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>(showPhaseOverlay ? 'learningExploration' : 'off');

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

  const overlayEnabled = overlayMode === 'learningExploration' && showPhaseOverlay;
  const phaseOverlays = useMemo(() => {
    if (!overlayEnabled) return [];
    return phaseOverlayPayloads
      .map((phasePayload) => {
        const phase = String(phasePayload.summary?.phase ?? phasePayload.summary?.task ?? 'phase');
        const phaseSeeker = phasePayload.config.seeker_id ?? seeker;
        const data = pointsForTag(phasePayload.tracking, phaseSeeker, t, true, roomX, roomY, rotate90).map((p) => ({ ...p, phase }));
        const endpoints = fullStartEnd(phasePayload.tracking, phaseSeeker, true, roomX, roomY, rotate90);
        return { phase, data, endpoints, color: phasePalette[phase] ?? '#344054' };
      })
      .filter((item) => item.data.length);
  }, [phaseOverlayPayloads, seeker, overlayEnabled, t, roomX, roomY, rotate90]);

  const startEndDots = groupedPlot.flatMap(({ tag, data }) => {
    const start = data[0];
    const end = data[data.length - 1];
    return [
      start ? { ...start, tag, label: `${tag} start`, kind: 'start' } : null,
      end ? { ...end, tag, label: `${tag} now`, kind: 'now' } : null,
    ].filter(Boolean) as Array<Record<string, any>>;
  });

  const legendItems = [
    ...groupedPlot.map(({ tag }, idx) => ({ name: tag, color: palette[idx % palette.length] })),
    ...(cooked.length ? [{ name: `${seeker} cooked α=0.4`, color: '#777' }] : []),
    ...phaseOverlays.map((item) => ({ name: `${item.phase} ${seeker}`, color: item.color, dashed: true })),
  ];

  const pointsOutOfRoom = payload.tracking.filter((p) => {
    const x = p.x_plot ?? p.x;
    const y = p.y_plot ?? p.y;
    return isFiniteNumber(x) && isFiniteNumber(y) && (x < 0 || x > roomX || y < 0 || y > roomY);
  }).length;

  return (
    <ChartCard
      title="Traiettoria 2D stanza"
      subtitle={`Stanza proporzionale ${roomX} m × ${roomY} m; vista ${rotate90 ? 'ruotata 90°' : 'originale'} per mantenere la scala fisica leggibile.`}
      className="span2"
    >
      {!groupedPlot.length ? (
        <div className="emptyState chartEmpty">Nessun punto 2D valido per questa sessione.</div>
      ) : (
        <>
          <div className="chartTools trajectoryTools compactTools">
            <label>
              Overlay traiettoria
              <select
                value={overlayMode}
                onChange={(e) => {
                  const next = e.target.value as OverlayMode;
                  setOverlayMode(next);
                  onShowPhaseOverlay?.(next === 'learningExploration');
                }}
              >
                <option value="off">sessione selezionata</option>
                <option value="learningExploration">learning + exploration stesso pp/path</option>
              </select>
            </label>
            <label>
              Stanza
              <select value={roomPreset} onChange={(e) => setRoomPreset(e.target.value as RoomPreset)}>
                <option value="8x12">8 m × 12 m</option>
                <option value="12x8">12 m × 8 m</option>
              </select>
            </label>
            <label>
              Orientamento
              <select value={rotate90 ? 'rotated' : 'original'} onChange={(e) => setRotate90(e.target.value === 'rotated')}>
                <option value="rotated">ruotato 90°</option>
                <option value="original">originale</option>
              </select>
            </label>
            <label className="inlineCheck">
              <input type="checkbox" checked={showAllTags} onChange={(e) => setShowAllTags(e.target.checked)} />
              P1 + target
            </label>
            <span className="timeBadge">t = {t.toFixed(2)} s / {computedDuration.toFixed(2)} s</span>
            {pointsOutOfRoom ? <span className="warningBadge">{pointsOutOfRoom} punti fuori stanza</span> : null}
          </div>

          <ChartFrame aspectRatio={roomAspect} minHeight={360} maxHeight={720} className="roomChartFrame">
            {(width, height) => (
              <ScatterChart
                width={width}
                height={height}
                margin={{ top: 18, right: 26, bottom: 36, left: 12 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="x2d"
                  name={rotate90 ? 'y originale' : 'x'}
                  unit=" m"
                  domain={[0, displayRoomX]}
                  ticks={Array.from({ length: Math.floor(displayRoomX) + 1 }, (_, i) => i)}
                  allowDataOverflow
                />
                <YAxis
                  type="number"
                  dataKey="y2d"
                  name={rotate90 ? 'x originale ruotata' : 'y'}
                  unit=" m"
                  domain={[0, displayRoomY]}
                  ticks={Array.from({ length: Math.floor(displayRoomY) + 1 }, (_, i) => i)}
                  allowDataOverflow
                />
                <Tooltip animationDuration={0} isAnimationActive={false} cursor={{ strokeDasharray: '3 3' }} content={<TrajectoryTooltip />} />

                <ReferenceLine x={0} stroke="#101828" strokeWidth={1.4} />
                <ReferenceLine x={displayRoomX} stroke="#101828" strokeWidth={1.4} />
                <ReferenceLine y={0} stroke="#101828" strokeWidth={1.4} />
                <ReferenceLine y={displayRoomY} stroke="#101828" strokeWidth={1.4} />

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
                  <ReferenceDot x={seekerStartEnd.start.x2d} y={seekerStartEnd.start.y2d} r={7} label="START" stroke="#101828" fill="#ffffff" ifOverflow="visible" />
                ) : null}
                {seekerStartEnd.end ? (
                  <ReferenceDot x={seekerStartEnd.end.x2d} y={seekerStartEnd.end.y2d} r={7} label="END" stroke="#101828" fill="#101828" ifOverflow="visible" />
                ) : null}
                {seekerNow ? (
                  <ReferenceDot x={seekerNow.x2d} y={seekerNow.y2d} r={8} label="NOW" stroke="#ffffff" fill="#d92d20" ifOverflow="visible" />
                ) : null}

                {phaseOverlays.flatMap((item) => {
                  const start = item.endpoints.start;
                  const end = item.endpoints.end;
                  return [
                    start ? <ReferenceDot key={`${item.phase}-start`} x={start.x2d} y={start.y2d} r={5} label={`${item.phase} start`} stroke={item.color} fill="#ffffff" ifOverflow="visible" /> : null,
                    end ? <ReferenceDot key={`${item.phase}-end`} x={end.x2d} y={end.y2d} r={5} label={`${item.phase} end`} stroke={item.color} fill={item.color} ifOverflow="visible" /> : null,
                  ];
                })}

                {startEndDots.filter((dot) => dot.tag !== seeker).map((dot) => (
                  <ReferenceDot
                    key={`${dot.tag}-${dot.kind}`}
                    x={dot.x2d}
                    y={dot.y2d}
                    r={dot.kind === 'start' ? 4 : 5}
                    label={dot.label}
                    stroke="#344054"
                    fill={dot.kind === 'start' ? '#ffffff' : '#344054'}
                    ifOverflow="visible"
                  />
                ))}
              </ScatterChart>
            )}
          </ChartFrame>
          <CustomLegend items={legendItems} />
          {overlayMode === 'learningExploration' && !phaseOverlays.length ? (
            <div className="miniWarning">Overlay richiesto: sto cercando le sessioni learning/exploration con stesso paziente, condition e path. Se non appare nulla, manca una delle due sessioni o non contiene punti P1 validi.</div>
          ) : null}
        </>
      )}
    </ChartCard>
  );
}
